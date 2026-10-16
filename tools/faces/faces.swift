// faces: sample frames from a video and detect face rectangles with Apple Vision.
//
// Build: tools/faces/build.sh  (swiftc -O tools/faces/faces.swift -o tools/faces/faces)
// Usage: faces <video> [--fps 4] [--start sec] [--end sec] [--max-side 960] [--out faces-raw.json]
//
// Output (stdout unless --out is given):
//   { "fps": 4, "width": W, "height": H, "duration": D,
//     "frames": [ { "t": 0.0, "faces": [ { "x", "y", "w", "h", "c" } ] } ] }
// Boxes are normalised to the upright frame with a top-left origin.
// Progress goes to stderr: "progress <done>/<total>" every 10 frames, then "done <n> frames in <sec> s".
// FACES_JOBS (env, default 2) sets how many frames run through Vision at once.

import AVFoundation
import CoreGraphics
import Foundation
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func log(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func usage() -> Never {
    fail("usage: faces <video> [--fps 4] [--start sec] [--end sec] [--max-side 960] [--out faces-raw.json]")
}

// Arguments
var videoPath: String?
var fps = 4.0
var startSec = 0.0
var endSec: Double?
var maxSide = 960.0
var outPath: String?

var args = Array(CommandLine.arguments.dropFirst())
var i = 0
func numberArg(_ name: String) -> Double {
    i += 1
    guard i < args.count, let v = Double(args[i]) else { fail("faces: \(name) needs a number") }
    return v
}
while i < args.count {
    let a = args[i]
    switch a {
    case "--fps": fps = numberArg(a)
    case "--start": startSec = numberArg(a)
    case "--end": endSec = numberArg(a)
    case "--max-side": maxSide = numberArg(a)
    case "--out":
        i += 1
        guard i < args.count else { fail("faces: --out needs a path") }
        outPath = args[i]
    case "-h", "--help": usage()
    default:
        if a.hasPrefix("--") { fail("faces: unknown option \(a)") }
        if videoPath != nil { usage() }
        videoPath = a
    }
    i += 1
}
guard let videoPath = videoPath else { usage() }
if fps <= 0 { fail("faces: --fps must be above 0") }
if maxSide < 16 { fail("faces: --max-side is too small") }

let url = URL(fileURLWithPath: videoPath)
if !FileManager.default.isReadableFile(atPath: url.path) {
    fail("faces: cannot open \(videoPath)")
}

// Load asset properties with the async API, waiting on a semaphore.
let asset = AVURLAsset(url: url)
var loadedDuration = CMTime.invalid
var naturalSize = CGSize.zero
var transform = CGAffineTransform.identity
var loadError: String?
var hasVideo = false
do {
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            let (duration, playable) = try await asset.load(.duration, .isReadable)
            loadedDuration = duration
            if !playable { loadError = "faces: cannot read \(videoPath)" }
            let tracks = try await asset.loadTracks(withMediaType: .video)
            if let track = tracks.first {
                hasVideo = true
                let (size, t) = try await track.load(.naturalSize, .preferredTransform)
                naturalSize = size
                transform = t
            }
        } catch {
            loadError = "faces: cannot open \(videoPath): \(error.localizedDescription)"
        }
        sem.signal()
    }
    sem.wait()
}
if let e = loadError { fail(e) }
if !hasVideo { fail("faces: no video track in \(videoPath)") }

let upright = CGRect(origin: .zero, size: naturalSize).applying(transform)
let width = Int(abs(upright.width).rounded())
let height = Int(abs(upright.height).rounded())
let duration = loadedDuration.isNumeric ? CMTimeGetSeconds(loadedDuration) : 0
if width <= 0 || height <= 0 { fail("faces: video track has no frame size") }

let start = max(0, startSec)
let end = min(endSec ?? duration, duration)
if end <= start { fail("faces: nothing to sample (start \(start), end \(end), duration \(duration))") }

// Sample times
let step = 1.0 / fps
var times: [NSValue] = []
var t = start
while t < end - 1e-6 {
    times.append(NSValue(time: CMTime(seconds: t, preferredTimescale: 600)))
    t = start + Double(times.count) * step
}
let total = times.count

// Generator
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
let scale = min(1.0, maxSide / Double(max(width, height)))
generator.maximumSize = CGSize(width: (Double(width) * scale).rounded(), height: (Double(height) * scale).rounded())
let tolerance = CMTime(seconds: step / 2, preferredTimescale: 600)
generator.requestedTimeToleranceBefore = tolerance
generator.requestedTimeToleranceAfter = tolerance

struct Face { let x, y, w, h, c: Double }
struct Frame { let t: Double; let faces: [Face] }

func detect(_ image: CGImage) -> [Face] {
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return [] }
    let results = request.results ?? []
    return results.map { obs in
        let b = obs.boundingBox
        // Vision uses a bottom-left origin; flip to top-left.
        let x = min(max(Double(b.origin.x), 0), 1)
        let y = min(max(1 - Double(b.origin.y + b.height), 0), 1)
        let w = min(Double(b.width), 1 - x)
        let h = min(Double(b.height), 1 - y)
        return Face(x: x, y: y, w: max(w, 0), h: max(h, 0), c: Double(obs.confidence))
    }
}

var frames = [Frame?](repeating: nil, count: total)
var done = 0
var failed = 0
let lock = NSLock()
let finished = DispatchSemaphore(value: 0)
let began = Date()
var indexFor: [Double: [Int]] = [:]
for (n, v) in times.enumerated() {
    indexFor[CMTimeGetSeconds(v.timeValue), default: []].append(n)
}

// Decoded frames are handed to a concurrent queue so decoding and detection overlap.
// The semaphore caps how many frames are in flight (and so how much memory is held).
let inFlight = DispatchSemaphore(value: max(1, Int(ProcessInfo.processInfo.environment["FACES_JOBS"] ?? "") ?? 2))
let workQueue = DispatchQueue(label: "faces.detect", attributes: .concurrent)

func record(_ requested: CMTime, _ actual: CMTime, _ result: AVAssetImageGenerator.Result, _ faces: [Face]) {
    let actualSec = (result == .succeeded && actual.isNumeric) ? CMTimeGetSeconds(actual) : CMTimeGetSeconds(requested)
    lock.lock()
    let key = CMTimeGetSeconds(requested)
    if var slots = indexFor[key], !slots.isEmpty {
        let n = slots.removeFirst()
        indexFor[key] = slots
        if result == .succeeded { frames[n] = Frame(t: actualSec, faces: faces) } else { failed += 1 }
    }
    done += 1
    let d = done
    lock.unlock()
    if d % 10 == 0 || d == total { log("progress \(d)/\(total)") }
    if d == total { finished.signal() }
}

generator.generateCGImagesAsynchronously(forTimes: times) { requested, image, actual, result, _ in
    guard result == .succeeded, let image = image else {
        record(requested, actual, result, [])
        return
    }
    inFlight.wait()
    workQueue.async {
        let faces = detect(image)
        inFlight.signal()
        record(requested, actual, result, faces)
    }
}
finished.wait()
let elapsed = Date().timeIntervalSince(began)

// JSON
func r(_ v: Double, _ places: Int) -> String {
    let p = pow(10.0, Double(places))
    var s = String(format: "%.\(places)f", (v * p).rounded() / p)
    if s.contains(".") {
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s += "0" }
    }
    if s == "-0.0" { s = "0.0" }
    return s
}

var out = "{\"fps\":\(r(fps, 4)),\"width\":\(width),\"height\":\(height),\"duration\":\(r(duration, 3)),\"frames\":["
var written = 0
for f in frames {
    guard let f = f else { continue }
    if written > 0 { out += "," }
    out += "\n{\"t\":\(r(f.t, 3)),\"faces\":["
    out += f.faces.map { "{\"x\":\(r($0.x, 4)),\"y\":\(r($0.y, 4)),\"w\":\(r($0.w, 4)),\"h\":\(r($0.h, 4)),\"c\":\(r($0.c, 4))}" }.joined(separator: ",")
    out += "]}"
    written += 1
}
out += "\n]}\n"

if let outPath = outPath {
    do { try out.write(toFile: outPath, atomically: true, encoding: .utf8) } catch {
        fail("faces: cannot write \(outPath): \(error.localizedDescription)")
    }
} else {
    FileHandle.standardOutput.write(out.data(using: .utf8)!)
}
if failed > 0 { log("skipped \(failed) frames that could not be decoded") }
log("done \(written) frames in \(r(elapsed, 2)) s")
