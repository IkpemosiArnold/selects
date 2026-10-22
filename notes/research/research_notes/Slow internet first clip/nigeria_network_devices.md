# Nigeria (Lagos) network, data cost, device and browser reality, as of 22 Oct 2026

Scope: hard, dated numbers for the Selects team (web app, long phone video in, captioned 9:16 clips out, hundreds of MB moved per session), turned into 3 test connection profiles. Exchange rate used throughout: NGN 1,333 per USD (CBN/NFEM close of NGN 1,332.99 on 12 Oct 2026, per [Nairametrics, 13 Oct 2026](https://nairametrics.com/2026/10/13/naira-holds-near-n1333-as-fx-turnover-swings/); the parallel market was about NGN 1,365 to 1,375 around 14 Oct 2026 per [Techeconomy, 14 Oct 2026](https://techeconomy.ng/dollar-to-naira-exchange-rate-today-october-14-2026)). USD figures below are my conversions at NGN 1,333.

Note on dashes: this file uses no em dashes. Ranges are written with "to" or a hyphen.

## Q1. Mobile download, upload and latency in Nigeria (2025 to 2026), per operator, and the spread

### Takeaway
Ookla's user-initiated tests put Nigeria's national median mobile speed at about 43 Mbps down, 11 Mbps up and 34 ms latency (Sep 2026), flat since late 2025. Background-measured "real user experience" numbers (Opensignal, nPerf) are much lower: about 13 to 21 Mbps down and only 2 to 8 Mbps up per operator. For an app that uploads hundreds of MB, upload is the binding constraint: realistic phone uploads are 2 to 8 Mbps, and Airtel and T2 are weaker than MTN.

### Cited Findings

**Ookla Speedtest Global Index, Nigeria (rolling quarter medians, user-initiated tests)** (Source: [Speedtest Global Index Nigeria page, "Updated September 2026"](https://www.speedtest.net/global-index/nigeria), embedded monthly data read on 22 Oct 2026)

| Index month | Mobile down Mbps | Mobile up Mbps | Mobile latency ms | Mobile jitter ms | Mobile rank | Fixed down | Fixed up | Fixed latency ms | Fixed rank |
|---|---|---|---|---|---|---|---|---|---|
| Sep 2025 | 44.58 | 12.12 | 30 | 14 | 85 | 29.36 | 16.63 | 24 | 128 |
| Dec 2025 | 44.14 | 12.28 | 31 | 17 | 83 | 33.32 | 19.61 | 23 | 127 |
| Mar 2026 | 50.53 | 12.09 | 32 | 17 | 81 | 36.81 | 20.83 | 23 | 123 |
| Jun 2026 | 46.17 | 11.70 | 33 | 18 | 81 | 36.71 | 22.37 | 24 | 128 |
| Sep 2026 (latest) | 43.43 | 11.05 | 34 | 18 | 85 | 36.77 | 22.45 | 23 | 131 |

- For comparison, Ookla's global medians for Sep 2026 were 90.14 / 15.96 Mbps mobile (47 ms) and 52.03 / 32.13 Mbps fixed (37 ms) (Source: [Speedtest Global Index Nigeria page](https://www.speedtest.net/global-index/nigeria)). Nigeria mobile is under half the global median; mobile upload is about 70% of global.
- Press reporting of the Dec 2025 figure: 44.14 Mbps, 85th globally (Source: [BusinessDay, 10 Feb 2026](https://businessday.ng/technology/article/nigeria-slips-to-85th-in-global-internet-speed-rankings-as-peers-pull-ahead/)). Small rank discrepancy (BusinessDay says 85th, the embedded data for the Dec 2025 index says 83).

**Opensignal Nigeria, July 2026 report (data Apr to Jun 2026), background-measured user experience** (Source: [Opensignal Nigeria July 2026](https://insights.opensignal.com/reports/2026/07/nigeria/mobile-network-experience); page blocked by Cloudflare for direct fetch, numbers below come from the search-indexed text of the report)

| Operator | Download Mbps | Upload Mbps | 5G upload Mbps | Consistent Quality | Reliability (100-1000) | 5G Availability |
|---|---|---|---|---|---|---|
| MTN | 21.3 | 7.9 | 16.4 | 18.5% | 656 | 26.8% |
| Airtel | 14.2 | 4.3 | 11.8 | 6.9% | 419 | 36.3% (winner) |
| Glo | 13.0 | 5.0 | n/a | 11.3% | 576 | n/a |
| T2 (ex 9mobile) | 17.6 | 1.9 | n/a | not found | 536 | n/a |

- Same report: MTN is "Best Network" for a second consecutive report and won 11 of 12 award categories outright (Source: [Opensignal Nigeria July 2026](https://insights.opensignal.com/reports/2026/07/nigeria/mobile-network-experience)).
- 5G download figures of 143.9 Mbps (MTN) and 129.3 Mbps (Airtel) appear in the indexed text but the metric label was cut off; treat as probably "5G Download Speed" but unconfirmed (Source: [Opensignal Nigeria July 2026](https://insights.opensignal.com/reports/2026/07/nigeria/mobile-network-experience)).
- July 2025 report (data Apr to Jun 2025): MTN Best Network; MTN overall download about 20 Mbps, about a third faster than Airtel and twice Glo; Airtel led video experience (Source: [Opensignal Nigeria July 2025](https://insights.opensignal.com/reports/2025/07/nigeria/mobile-network-experience), via indexed text).

**nPerf 2025 barometer (calendar 2025, 40,617 tests)** (Source: [ITEdgeNews, 16 Jan 2026](https://www.itedgenews.africa/mtn-tops-nigerias-mobile-internet-rankings-in-2025-as-competition-intensifies-nperf-report/))
- MTN: 18.7 Mbps down, 8.7 Mbps up, 37,106 nPoints. Airtel: 10.6 Mbps down, 4.7 Mbps up, 25,614 nPoints. Glo: 20,475 nPoints, latency 121.8 ms (download/upload not stated). Market average 27,732 nPoints.
- MTN web browsing score 35.8%, Glo 29.9%; video streaming MTN 67.0%, Airtel 62.5%.
- The article calls Glo's 121.8 ms "industry-best" latency while also saying MTN "dominated all measured indicators"; this is internally inconsistent and unresolved. A search summary cited an MTN latency of 96.46 ms, which I could not confirm in the fetched article.
- nPerf national average mobile download reported as 14.7 Mbps in Q4 2025 (Source: search summary citing [BusinessDay](https://businessday.ng/technology/article/nigeria-slips-to-85th-in-global-internet-speed-rankings-as-peers-pull-ahead/); not in the fetched portion of the article, treat as unverified).
- nPerf: tests on 4G across MTN, Airtel and Glo accounted for 64% of measurements in 2025 (Source: search summary of nPerf coverage, [Techeconomy](https://techeconomy.ng/mtn-nigerias-best-mobile-network-for-2025); not directly verified).

**Ookla operator data (H1 2025 and Q2 2025)**
- H1 2025 Speedtest Intelligence: MTN Nigeria 5G median download 226.6 Mbps vs Airtel 182.6 Mbps; 4G availability MTN 91.2% vs Airtel 89.9%; Airtel overall median download 17.44 Mbps (Source: [TechCabal, 5 Nov 2025](https://techcabal.com/2025/11/05/mtn-tops-africas-mobile-speed-charts-as-vodacom-leads-5g-race/)). MTN's overall median was not in the extracted text.
- Q2 2025: MTN median 95.62 Mbps down and 17.01 Mbps up (Source: [Condia, 4 Nov 2025](https://thecondia.com/?p=23749)). This looks inconsistent with a national median of about 44 Mbps when MTN carries most tests; it may refer to a subset (e.g. modern devices or 5G-capable). Treat as suspect.
- Ookla/NCC rural report: average rural download MTN 15 Mbps, Airtel 11 Mbps, Glo about 9 Mbps (Source: search summary of [Techeconomy](https://www.techeconomy.ng/ookla-ranks-mtn-nigeria-as-the-fastest-network-in-west-and-central-africa); date not confirmed).

**Spread / percentiles**
- I found no public 10th or 25th percentile figures for Nigeria from Ookla, Opensignal or nPerf. The closest proxies are Opensignal "Consistent Quality" (share of tests that meet thresholds for typical app use): MTN 18.5%, Glo 11.3%, Airtel 6.9% (Apr to Jun 2026) (Source: [Opensignal Nigeria July 2026](https://insights.opensignal.com/reports/2026/07/nigeria/mobile-network-experience)), and Ookla jitter of 18 ms mobile median (Source: [Speedtest Global Index](https://www.speedtest.net/global-index/nigeria)).

**Live test from this Mac, 22 Oct 2026, 14:17 to 14:29 UTC (15:17 to 15:29 WAT), Lagos** (Source: my own measurements with curl and ping; no browser tools)
- Connection: Wi-Fi SSID "Airtel_X25 MAX2_73CD_5G" (an Airtel-branded router; the "5G" suffix may mean the 5 GHz Wi-Fi band or a 5G service, unknown). Public IP 105.115.5.52, whois "Airtel Networks Limited", AS36873. Traceroute shows several private hops (10.3.255.254, 172.24.240.x, 192.168.20.2), consistent with carrier-grade NAT.
- Cloudflare trace: `loc=NG`, `colo=CDG` (Paris) for www.cloudflare.com and cloudflare.com, but `colo=LOS` (Lagos) for speed.cloudflare.com on the second run. Airtel traffic is not always served from the Lagos PoP.
- Run 1 (14:17 UTC): 25 MB download from speed.cloudflare.com: 19.75 Mbps (10.1 s, TTFB 0.23 s) and 14.26 Mbps (14.0 s, TTFB 0.54 s). 5 MB upload: 7.49 Mbps (5.3 s).
- Run 2 (about 14:25 to 14:29 UTC): three 10 MB downloads at 3.78, 6.76 and 7.25 Mbps; one 50 MB download at 7.01 Mbps (57.1 s); 10 MB upload at 8.97 Mbps (8.9 s). Download throughput fell by about 50 to 75% within roughly 10 minutes on the same link.
- ICMP RTT (10 pings each): cloudflare.com avg 17.2 ms (12.3 to 25.4); huggingface.co avg 36.2 ms but max 220 ms (stddev 61); cdn.jsdelivr.net avg 18.5 ms; api.groq.com avg 24.1 ms (max 76); 8.8.8.8 avg 16.4 ms; 1.1.1.1 100% ICMP loss (ICMP to that anycast address appears blocked or filtered). Far hosts: www.abc.net.au (Akamai edge) 150.8 ms avg (112 to 258); www.yahoo.co.jp 347 ms; www.gov.za 348 ms avg (283 to 413). Packet loss on all reachable hosts was 0% in 10-packet samples.
- HTTPS setup: huggingface.co TCP 21 ms, TLS done 0.44 s, TTFB 0.66 s; cdn.jsdelivr.net TLS 0.07 s, TTFB 1.55 s; api.groq.com TLS 0.08 s, TTFB 0.60 s; one speed.cloudflare.com request took 1.08 s to connect and 2.61 s to finish TLS (a one-off stall).

### Inferences
- Ookla medians come from user-started tests on (often better) phones near a local test server, so they overstate what a background upload in a web app will see. Opensignal and nPerf per-operator numbers (13 to 21 Mbps down, 2 to 9 Mbps up) are the better basis for a "typical" profile.
- Upload is the bottleneck for Selects. At 4.3 Mbps (Airtel Opensignal median) a 300 MB upload takes about 9.3 minutes of perfect transfer; at 1.9 Mbps (T2) it takes about 21 minutes; at 7.9 Mbps (MTN) about 5 minutes.
- Ookla's 34 ms latency is to a nearby (Lagos) test server. Latency to app origins in Europe or the US is much higher; my live test showed 113 to 413 ms to non-CDN or far hosts, and CDN-fronted hosts (Cloudflare, Fastly via jsdelivr, Groq on Cloudflare, Hugging Face on CloudFront) at 17 to 36 ms average with spikes to 220 ms.
- Throughput on a single link moved from about 20 Mbps to about 4 Mbps within 10 minutes in my test; a profile that holds a constant rate is too optimistic. Tests should vary throughput over time.
- Fixed broadband in Nigeria (Ookla median 36.77 down / 22.45 up) is actually slower on download than mobile (43.43), but has twice the upload and lower latency (23 ms). "Good Wi-Fi" in Nigeria is not fast by global standards.

### Gaps
- No percentile (p10/p25) data for Nigeria found from any public source.
- Opensignal 2026 page could not be fetched directly (Cloudflare challenge); per-operator video, games and latency numbers were not retrievable. 5G download labels unconfirmed.
- No Lagos-only per-operator speed numbers found for 2026 (Ookla has state-level reporting; a Guardian piece ranked Kano fastest state, not fetched).
- No public packet-loss rates for Nigerian mobile networks found.

## Q2. 4G vs 5G coverage and share, NCC subscriber statistics

### Takeaway
As of mid-2026 about 54% of Nigerian mobile connections are 4G, about 4.5% are 5G, and over 41% are still 2G or 3G. Broadband penetration is about 57%. 5G exists in Lagos but more than half of Lagos had no 5G coverage at end of 2025, so 4G is the realistic default for testing.

### Cited Findings
- NCC data for May 2026: 4G 54.3% of mobile connections, 5G 4.49%, 2G and 3G together "more than 41%"; 189.68 million active mobile subscriptions (Source: [Techeconomy, 31 Aug 2026, citing NCC data published 31 Jul](https://techeconomy.ng/5g-lags-as-4g-commands-543-of-nigerias-mobile-connections)). 4.49% of 189.68M is about 8.5M 5G connections (my calculation).
- April 2026 NCC: 2G share 35.93% (down from 36.74%), 3G 5.32% (Source: search summary of [Brandcom, 29 Jun 2026](https://brandcom.ng/2026/06/29/telecom-subscription-in-nigeria-rises-to-188m-as-broadband-penetration-reaches-55-67/); not directly fetched).
- 5G grew from under 0.1% (May 2023) to 4.5% (May 2026) of mobile subscriptions (Source: search summary of [Intelpoint](https://intelpoint.co/insights/despite-a-steady-decline-over-40-of-nigerias-mobile-users-still-rely-on-2g/)).
- "Telcos connect 7.2m Nigerians to 5G" (Source: [Guardian Nigeria headline](https://guardian.ng/business-services/telcos-connect-7-2m-nigerians-to-5g-as-teledensity-grows-by-1-19/); date not confirmed, figure older than the 8.5M estimate above).
- Broadband penetration (NCC, monthly 2026): 53.07% Jan, 53.86% Feb, 54.30% Mar, 55.67% Apr, 56.11% May, 56.79% Jun, 57.40% Jul 2026; broadband subscriptions 124.4M in Jul 2026 vs about 105.2M in Aug 2025 (Source: [Techeconomy, Oct 2026](https://techeconomy.ng/nigerias-broadband-penetration-reaches-574-as-subscriptions-rise-to-1244-million)). Sources conflict on Dec 2025 (50.58% vs 51.97%).
- Active internet subscriptions 157,405,351 in May 2026, of which 157,021,888 via mobile GSM (Source: [ThisDay, 27 Aug 2026](https://www.thisdaylive.com/2026/08/27/internet-subscribers-hit-157-4m-as-broadband-penetration-increases-to-56-11/), via search summary).
- 5G availability (share of time on 5G among 5G users), Apr to Jun 2026: Airtel 36.3%, MTN 26.8% (Source: [Opensignal Nigeria July 2026](https://insights.opensignal.com/reports/2026/07/nigeria/mobile-network-experience)).
- NCC: in Lagos about 55.4% of the area had no 5G coverage at all in Q4 2025 (Abuja 47.4%); a separate figure says about 70.9% of 5G-capable devices in Lagos (65.6% Abuja) could not connect to 5G (Source: [AllAfrica, 31 Aug 2026](https://allafrica.com/stories/202608310321.html) and [Condia, 4 Nov 2025](https://thecondia.com/?p=23749)). Dating of the 70.9% figure conflicts between sources (Q3 2025 vs Q2 2026).
- MTN 5G population coverage was 12.7% per its 2024 annual report (Source: [Condia, 4 Nov 2025](https://thecondia.com/?p=23749)). No 2026 MTN 5G coverage figure found.
- Ookla 4G availability H1 2025: MTN 91.2%, Airtel 89.9% (Source: [TechCabal, 5 Nov 2025](https://techcabal.com/2025/11/05/mtn-tops-africas-mobile-speed-charts-as-vodacom-leads-5g-race/)).
- Airtel added 657 5G-dedicated sites within 1,050+ new sites (Source: [Techeconomy, 31 Aug 2026](https://techeconomy.ng/5g-lags-as-4g-commands-543-of-nigerias-mobile-connections)). MTN and Mafab each paid USD 273.6M for 5G spectrum in 2021 (same source).
- MTN H1 2026: 92.2M subscribers, active data users 55.7M (Source: search summary of [BusinessDay South Africa, 31 Jul 2026](https://www.businessday.co.za/companies/earnings/2026-07-31-mtn-nigeria-profit-soars-as-it-gains-5-million-new-subscribers/)).

### Inferences
- Over 40% of connections still on 2G/3G includes many feature phones and secondary SIMs; Selects users will mostly be smartphone users on 4G, but a slice will fall back to 3G in weak spots, which supports a "bad" profile well under 5 Mbps.
- Even Lagos 5G users spend only about 27 to 36% of time on 5G, so a 5G profile is not a sensible default; 5G is a best case.

### Gaps
- No Mafab 5G subscriber or coverage numbers found.
- No NCC breakdown of 4G/5G share specifically for Lagos State.

## Q3. Data prices per GB after the 2025 tariff increase, plus fixed options

### Takeaway
After the NCC-approved tariff rise (early 2025), mainstream mobile data in Nigeria costs about NGN 300 to 670 per GB on the small and mid bundles people actually buy (USD 0.23 to 0.50), down to about NGN 120 to 200 per GB on big monthly or 60-day bundles (USD 0.09 to 0.15), and up to about NGN 3,000 to 4,600 per GB (USD 2.30 to 3.45) on out-of-bundle pay-as-you-go. A 300 MB upload costs a typical user about NGN 100 to 200 (USD 0.08 to 0.15) from a mid bundle, but takes a big bite out of a 1.5 GB weekly bundle.

### Cited Findings

**2025 tariff increase**
- After the NCC approved a tariff increase of up to 50%, MTN in Feb 2025 replaced its 1.5 GB monthly at NGN 1,000 with 1.8 GB at NGN 1,500; 20 GB went from NGN 5,500 to NGN 7,500; 1.5 TB 90-day from NGN 150,000 to NGN 240,000; 600 GB 90-day from NGN 75,000 to NGN 120,000; a weekly 15 GB at NGN 2,000 briefly went to NGN 6,000 and MTN called it a mistake (Source: [TechCabal, 11 Feb 2025](https://techcabal.com/2025/02/11/mtn-nigeria-raises-internet-prices/), via search summary; direct fetch returned 403). MTN said it was not a flat 50% on every plan (same source; also [Zikoko](https://www.zikoko.com/citizen/mtn-raises-data-prices/)).

**Bundle prices as of Feb 2026** (Source: [Mobility.com.ng, 27 Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/); prices "as of February 2026"; per-GB and USD are my calculations at NGN 1,333/USD)

| Operator | Bundle | Validity | NGN | NGN/GB | USD/GB |
|---|---|---|---|---|---|
| MTN | 1 GB | 1 day | 350 | 350 | 0.26 |
| MTN | 1.5 GB | 7 days | 1,000 | 667 | 0.50 |
| MTN | 7 GB | 7 days | 2,500 | 357 | 0.27 |
| MTN | 2 GB (+2 GB night) | 30 days | 1,500 | 750 | 0.56 |
| MTN | 10 GB (+2 GB night) | 30 days | 4,500 | 450 | 0.34 |
| MTN | 20 GB (+4 GB night) | 30 days | 7,500 | 375 | 0.28 |
| MTN | 45 GB | 30 days | 9,000 | 200 | 0.15 |
| MTN | 120 GB | 30 days | 20,000 | 167 | 0.13 |
| MTN | Pay as you go | n/a | 3.07 per MB | about 3,070 | about 2.30 |
| Airtel | 1 GB | 1 day | 350 | 350 | 0.26 |
| Airtel | 1.5 GB | 7 days | 1,000 | 667 | 0.50 |
| Airtel | 2 GB (+2 GB night) | 30 days | 1,500 | 750 | 0.56 |
| Airtel | 12 GB | 30 days | 4,000 | 333 | 0.25 |
| Airtel | 25 GB | 30 days | 8,000 | 320 | 0.24 |
| Airtel | 100 GB | 30 days | 20,000 | 200 | 0.15 |
| Airtel | Pay as you use | n/a | 4.60 per MB | about 4,600 | about 3.45 |
| Glo | 3.2 GB | 7 days | 1,000 | 313 | 0.23 |
| Glo | 2.6 GB (+night) | 30 days | 1,000 | 385 | 0.29 |
| Glo | 10.5 GB (+night) | 30 days | 3,000 | 286 | 0.21 |
| Glo | 165 GB | 30 days | 20,000 | 121 | 0.09 |
| T2 | 2.5 GB | 30 days | 1,000 | 400 | 0.30 |
| T2 | 11.5 GB | 30 days | 4,000 | 348 | 0.26 |

- Other 2026 guides broadly agree (MTN 10 GB monthly about NGN 4,500; Airtel 10 GB about NGN 4,500 in one comparator; Glo cheapest per GB; VTU/SME reseller prices lower, e.g. MTN 10 GB NGN 3,000 official vs NGN 2,100 via reseller in one source) (Source: [wtec.org.ng comparator](https://wtec.org.ng/data-plans/); [vtyield.com, 2026](https://vtyield.com/blog/cheapest-data-nigeria-2026); [naijasabi](https://naijasabi.com.ng/nigeria-data-plan-comparison/)). These are blogs of uneven quality and some numbers conflict with Mobility.com.ng.

**Night plans and social bundles**
- MTN: "All Night" 2 to 4 GB (12 AM to 5 AM) bundled into most monthly plans; some weekly plans add 100 MB YouTube all day and 1 GB YouTube night. Airtel: 2 GB All Night on the NGN 1,500 monthly; 1 GB YouTube Night and 200 MB YouTube Music/Spotify on a NGN 500 weekly. Glo: night bonus (12 AM to 5 AM) on almost all plans; 1 GB for NGN 200 on Sundays only. T2: NGN 25 for 7 days of Facebook-only access (Source: [Mobility.com.ng, 27 Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/)).
- Glo weekly "1.5 GB (Social)" for NGN 500 (Source: search summary of [naijasabi Glo plans 2026](https://naijasabi.com.ng/glo-data-plans-nigeria-2026/)).

**Expiry, rollover, FUP, hotspot**
- NCC's 2018 rollover directive requires unused data to be added to a renewed subscription, with fines for non-compliance (Source: [Ripples Nigeria](https://www.ripplesnigeria.com/ncc-order-on-data-rollover-kicks-off-today)).
- MTN practice (per 2026 consumer guides): unused main data rolls over only if the same category of plan is renewed within a grace period (7 days monthly, 3 days weekly, 1 day daily); bonus and night data never roll over; expired data cannot be restored; the bundle with the shortest validity is consumed first (Source: [Androidpols, Jan 2026](https://www.androidpols.com.ng/2026/01/how-to-rollover-mtn-data-complete-2026.html); [Legit.ng](https://www.legit.ng/ask-legit/guides/1730950-how-check-mtn-data-expiry-date-bonus-night-data-vanish-good/)). Blog sources, not MTN terms.
- Airtel: up to 50% of unused data rolls over on select plans if renewed before or right after expiry (Source: [Mobility.com.ng, 27 Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/)).
- Airtel "Unlimited" mobile plans: NGN 10,000 (40 GB cap), NGN 15,000 (65 GB cap), NGN 20,000 (100 GB cap) for 30 days, then throttled to 256 kbps after the fair-use cap (Source: [Mobility.com.ng, 27 Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/)).
- Hotspot/tethering: I found no source saying Nigerian bundles treat tethered data differently; no operator source found either way.

**Fixed and "good Wi-Fi" options**
- Airtel SmartConnect 5G outdoor router: about NGN 25,000 entry (SIM, installation, 30-day unlimited at up to 50 Mbps); then NGN 25,000/month unlimited 50 Mbps or NGN 45,000/month unlimited 100 Mbps; router can be retrieved after 3 months without renewal (Source: [Brandcom, 16 Sep 2025](https://brandcom.ng/2025/09/16/airtel-nigeria-launches-smartconnect-5g-router-to-expand-internet-access/); [Mobility.com.ng](https://mobility.com.ng/airtel-5g-smart-connect-unlimited-internet/)). One outlet gives NGN 50,000 as the router price (conflict). In USD: NGN 25,000 = USD 18.76; NGN 45,000 = USD 33.76.
- MTN Unlimited 5G Broadband comes in 50 Mbps and 100 Mbps tiers with 30 days free on router purchase; no confirmed 2026 naira price found (Source: [The Condia](https://thecondia.com/mtn-unlimited-5g-broadband-data/)). MTN FiberX (approx.): 10 Mbps NGN 15,000; 25 Mbps NGN 22,000; 50 Mbps NGN 35,000; 100 Mbps NGN 55,000 per month (Source: [Mobility.com.ng, Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/)).
- Starlink Nigeria: Residential NGN 57,000/month (USD 42.76) with 1 TB fair-use, often "sold out" or waitlisted in Lagos, Abuja and Port Harcourt; Roam NGN 38,000; Business NGN 159,000; Standard kit about NGN 590,000 (USD 443), Mini kit about NGN 318,000 (USD 239) (Source: [Mobility.com.ng, Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/); [TechCabal, 11 Nov 2025](https://techcabal.com/2025/11/11/starlink-nigeria-price-and-availability/)).
- FiberOne: 16 Mbps NGN 11,450; 30 Mbps about NGN 20,000; 50 Mbps about NGN 32,000, described as unlimited without FUP. ipNX: 20 Mbps NGN 22,253 to 200 Mbps NGN 106,425, plus about NGN 55,900 setup. Spectranet (4G LTE fixed wireless): volume plans e.g. 25 GB NGN 10,000, 60 GB NGN 18,000, 300 GB about NGN 50,000; night plans 7 PM to 7 AM (Source: [Mobility.com.ng, Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/)).

**International comparisons**
- Cable.co.uk 2025 Nigeria average 1 GB price: not found. Older editions: about USD 0.88/GB (2021, 43rd globally) and about USD 2.22/GB (an edition of uncertain year), and 31st globally in 2023 (Source: search summaries of [ITEdgeNews](https://itedgenews.africa/nigeria-is-43rd-in-the-world-for-cheapest-mobile-data-ahead-of-uk-south-africa/) and [Techbuild Africa](https://techbuild.africa/mobile-data-nigeria-expensive-affordable/)). Flag as old and inconsistent.

### Inferences
- Cost of moving 300 MB (one long video upload) at realistic rates: about NGN 100 (Airtel 12 GB plan) to NGN 200 (MTN 1.5 GB weekly) or NGN 900 to 1,380 at pay-as-you-go (USD 0.08 to 0.15, or USD 0.69 to 1.04). On a 1.5 GB weekly bundle, one 300 MB upload plus a 200 MB result download is a third of the user's week.
- Night data (12 AM to 5 AM) is common and free-ish for users on monthly plans. A "queue big upload for tonight" option fits Nigerian habits.
- Large fixed plans (Airtel 5G FWA, fibre, Starlink) are unlimited or near-unlimited, so the "good Wi-Fi" user does not care about MB cost, only time.

### Gaps
- No primary telco page was fetched (mtn.ng, airtel.com.ng, gloworld.com); prices are from Feb 2026 third-party lists and may have shifted by Oct 2026.
- Cable.co.uk 2025 Nigeria figure not found.
- Hotspot metering policy not found.

## Q4. Device mix: OS, brands, RAM, chipsets, iPhones

### Takeaway
In Sep 2026 Nigerian mobile web traffic was 84% Android and 16% iOS (iOS up from about 10% in early 2025). Transsion brands (Tecno, Infinix, itel) are about 42% of mobile web traffic, with Samsung, Apple and Xiaomi each 13 to 17%. The volume Android phones are entry-level devices with 3 to 4 GB RAM (sometimes 8 GB with "virtual RAM" marketing) on Unisoc T7xxx or MediaTek Helio G8x chips at a 720p-class screen (360x800 CSS viewport). iPhones are mostly UK-used iPhone 11 to 13 class.

### Cited Findings

**StatCounter, Nigeria mobile (share of mobile web pageviews)** (Source: [StatCounter OS](https://gs.statcounter.com/os-market-share/mobile/nigeria), [vendor](https://gs.statcounter.com/vendor-market-share/mobile/nigeria), monthly CSV Jan 2025 to Sep 2026 pulled 22 Oct 2026)

| Month | Android | iOS | Tecno | Infinix | Samsung | Apple | Xiaomi | itel | Oppo | Unknown |
|---|---|---|---|---|---|---|---|---|---|---|
| Jan 2025 | 90.19 | 9.55 | 23.25 | 21.36 | 12.49 | 9.32 | 6.93 | 5.53 | 3.58 | 8.59 |
| Jun 2025 | 89.58 | 10.11 | 21.74 | 18.29 | 14.05 | 9.82 | 8.22 | 5.55 | 3.91 | 10.16 |
| Dec 2025 | 87.10 | 12.64 | 19.47 | 16.90 | 14.45 | 12.26 | 7.95 | 4.77 | 4.31 | 12.12 |
| Jun 2026 | 82.69 | 17.21 | 17.20 | 15.06 | 16.25 | 17.19 | 7.83 | 3.89 | 4.10 | 11.65 |
| Sep 2026 | 84.22 | 15.67 | 20.46 | 16.86 | 17.22 | 15.66 | 12.90 | 4.80 | 3.11 | 3.47 |

- Platform split, Nigeria, Sep 2026: mobile 75.22%, desktop 24.36%, tablet 0.43% (Source: [StatCounter platform](https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/nigeria)).
- Android versions (mobile and tablet), Sep 2026: 15 = 20.9%, 14 = 15.94%, 16 = 13.71%, 13 = 12.64%, 12 = 11.6%, 11 = 9.6% (Source: [StatCounter Android version](https://gs.statcounter.com/android-version-market-share/mobile-tablet/nigeria)).
- Mobile screen resolutions (CSS px), Sep 2026: 360x800 20.61%, 360x806 13.71%, 360x820 8.33%, 414x896 8.03%, 412x915 5.95%, 385x854 4.38% (Source: [StatCounter screen resolution](https://gs.statcounter.com/screen-resolution-stats/mobile/nigeria)).
- Feb 2025 StatCounter: Tecno 23.55%, Infinix 21.73%, itel 5.41% (Transsion 50.69%), Samsung 12.36%, Apple 9.43% (Source: [Intelpoint](https://intelpoint.co/insights/tecno-has-the-highest-share-among-phone-brands-in-nigeria-at-23-55-as-of-february-2025/)).
- Most-searched phones in Nigeria in 2025 (Google, search interest not sales): iPhone 17, Tecno Pop 10, Redmi 14C, Redmi 15C, Tecno Spark 40, Redmi A5, Infinix Note 50 Pro; Tecno Spark 40 priced about NGN 70,000 to 100,000 (Source: [Techeconomy](https://www.techeconomy.ng/most-searched-smartphones-in-nigeria-for-2025)).

**Specs of popular models (RAM / chipset)**
- Tecno Spark 40C (also sold as Pop 10 Pro): MediaTek Helio G81 (12 nm), Mali-G52 MC2, 4 GB or 8 GB RAM, announced 19 Jul 2025 (Source: [GSMArena](https://m.gsmarena.com/tecno_spark_40c-14052.php), via search summary).
- Tecno Pop 10 (4G): Unisoc T7250, 3 GB RAM, 64/128 GB storage (Source: [Mobility.com.ng](https://mobility.com.ng/tecno-pop-10-specs-price/), via search summary); a 5G variant is listed with 4 GB (Source: [Smartprix](https://www.smartprix.com/mobiles/xiaomi_redmi_a5_5g_vs_tecno_pop_10_5g-cpd1cr0dnvmi_pd153pscds0.php)).
- itel A90: Unisoc T7100, 4 GB RAM (Source: [Findprix](https://www.findprix.com/mobiles/compare/itel-a90-4gb-ram-128gb-4362-vs-infinix-hot-60i-5g-3613)).
- Redmi 14C: 4 GB RAM, 6.88-inch 720x1640 display (Source: [Smartprix](https://us.smartprix.com/mobiles/tecno_spark_40c_5g_vs_xiaomi_redmi_14c-cpd1yplsw1p0_pd1jtt9hqnc.php)). Redmi A5 5G: 4 GB (Source: [Smartprix](https://www.smartprix.com/mobiles/xiaomi_redmi_a5_5g_vs_tecno_pop_10_5g-cpd1cr0dnvmi_pd153pscds0.php)).
- Infinix Hot 60i 5G: MediaTek Dimensity 6400, 4 GB RAM; Hot 60 5G listed with 6 GB (Source: [Smartprix](https://www.smartprix.com/mobiles/tecno_pop_x_vs_infinix_hot_60_5g-cpd1p3ub0zgv_pd1cdew27pi.php)).

**iPhones**
- Nigeria's iPhone market is mostly pre-owned "London-used" (UK and other imports via Computer Village, Lagos) (Source: [TechCabal, 10 Nov 2022](https://techcabal.com/2022/11/10/inside-nigerias-used-iphones-market/); older but describes the structure).
- UK-used prices in Q2 2026: iPhone 11 NGN 120,000 to 170,000 (USD 90 to 128); iPhone 12 NGN 200,000 to 260,000; iPhone 13 mini NGN 230,000 to 280,000; iPhone 13 NGN 250,000 to 300,000; iPhone SE 2022 NGN 180,000 to 220,000 (Source: [Revibyte, 25 Apr 2026](https://www.revibyte.blog/posts/best-iphones-under-300k-nigeria-2026/)). No sales ranking given.
- 2026 guide: iPhone 14 NGN 850,000 to 1.2M (likely new or near-new) (Source: [Slot blog, Apr 2026](https://blog.slot.ng/iphone-price-list-nigeria-updated-april-2026-current-prices-where-to-buy)).

### Inferences
- The 414x896 viewport at 8.03% of Nigerian mobile web traffic is the CSS size of iPhone XR, 11, XS Max and 11 Pro Max, so the XR/11 generation is likely the single most common iPhone class on the Nigerian web. Commonly published Apple specs give iPhone XR 3 GB RAM, iPhone 11/12/13/SE 2022 4 GB RAM (not re-verified this session; check GSMArena or Apple if the exact number matters).
- About 21% of Nigerian Android traffic is on Android 11 or 12 or older. Test on an older Chrome-on-Android baseline.
- The Android mid-point device for testing is a 4 GB RAM, Helio G81/G85 or Unisoc T7250-class phone with a 720p screen. Video decode and in-browser processing (e.g. ffmpeg.wasm, WebCodecs) will be slow and memory-limited on these; 3 GB phones (Tecno Pop 10) are the floor.
- StatCounter counts web pageviews, so it overweights heavier web users and probably underweights the cheapest phones relative to the installed base.

### Gaps
- No Counterpoint/IDC Nigeria sales ranking with RAM mix found.
- No per-country iPhone model share found.

## Q5. Browser mix in Nigeria (mobile)

### Takeaway
Chrome dominates (68% in Sep 2026, up from 57% in Jan 2025). Opera is still large (18%, down from 33%). Safari is about 11%. Samsung Internet, UC, Firefox and Phoenix are each around 1% or less. Opera's share likely includes Opera Mini, whose server-side rendering cannot run a modern video app.

### Cited Findings
StatCounter mobile browser share, Nigeria (Source: [StatCounter mobile browser Nigeria](https://gs.statcounter.com/browser-market-share/mobile/nigeria), monthly CSV pulled 22 Oct 2026)

| Month | Chrome | Opera | Safari | Samsung Internet | UC Browser | Firefox | Brave | Phoenix |
|---|---|---|---|---|---|---|---|---|
| Jan 2025 | 57.09 | 33.41 | 7.19 | 1.01 | 0.61 | 0.29 | 0 | 0.21 |
| Jun 2025 | 61.18 | 28.61 | 7.54 | 1.24 | 0.58 | 0.26 | 0.14 | 0.17 |
| Dec 2025 | 59.65 | 28.76 | 9.02 | 1.37 | 0.20 | 0.40 | 0.18 | 0.16 |
| Jun 2026 | 64.51 | 19.70 | 12.71 | 1.05 | 0.68 | 0.53 | 0.31 | 0.17 |
| Sep 2026 | 68.00 | 18.05 | 10.98 | 1.23 | 0.60 | 0.61 | 0.02 | 0.13 |

### Inferences
- Test matrix priority for Selects: Chrome on Android (about 68%), Opera on Android (about 18%, includes Opera Mini, which should get a "open in Chrome" fallback), Safari on iOS (about 11%). Samsung Internet and Phoenix (Transsion's built-in browser) are around 1% and 0.1%.
- Many links are opened inside in-app browsers (WhatsApp, Instagram, X, TikTok webviews); StatCounter usually attributes those to Chrome/Safari engines, so file pickers and large downloads in webviews deserve a test.

### Gaps
- StatCounter does not split Opera vs Opera Mini in this view; the Opera Mini share in Nigeria for 2026 was not found.

## Q6. Reliability: drops, throttling, proxies, FUP, large-download failures

### Takeaway
There is strong evidence of peak-hour congestion, frequent fibre cuts and many quality complaints, and my own test showed throughput swinging by 4x in 10 minutes. I found no direct forum evidence that 100 to 200 MB downloads routinely fail, and no evidence of a carrier proxy that blocks large files, but uploads and downloads of this size should be resumable and tolerate stalls.

### Cited Findings
- NCC H1 2026: 413,587 consumer complaints (network quality, data depletion, billing, failed transactions): Airtel 228,992, MTN 124,405, Glo 56,810, T2 3,885 (Source: [Techeconomy, 29 Sep 2026](https://techeconomy.ng/ncc-nigeria-telecom-complaints-hit-413587-in-h1-as-data-billing-issues-persist); [AllAfrica, 30 Sep 2026](https://allafrica.com/stories/202609300212.html)). Data depletion complaints about 23,400 (MTN 12,212, Airtel 9,806, Glo 1,373, T2 5) (Source: search summary of the same AllAfrica report).
- "Networks in many parts of the country now struggling during peak hours, leaving subscribers with slower internet speeds and unstable connections"; 19,384 fibre cuts in 2025 and 5,934 in Q1 2026 alone (Source: [Techeconomy, 28 May 2026](https://www.techeconomy.ng/nigeria-telecom-data-calculators-data-depletion-complaints)).
- NCC says capacity constraints are observed in dense urban areas across all major operators; only about 25% of planned 2026 4G expansion projects had been completed (Source: search summary of [Guardian Nigeria](https://guardian.ng/business-services/ncc-appeals-to-subscribers-on-service-quality-tasks-telcos-on-accountability/) and [AllAfrica, 7 Jan 2026](https://allafrica.com/stories/202601070227.html); figure not directly verified).
- NCC ran an independent data-depletion audit, completed Q3 2024; NCC's EVC said "We had a hypothesis that it isn't true that there is a data depletion issue" (Source: [Techeconomy, 28 May 2026](https://www.techeconomy.ng/nigeria-telecom-data-calculators-data-depletion-complaints)).
- Opensignal Reliability scores (Apr to Jun 2026): MTN 656, Glo 576, T2 536, Airtel 419 (Source: [Opensignal Nigeria July 2026](https://insights.opensignal.com/reports/2026/07/nigeria/mobile-network-experience)).
- FUP throttling exists on "unlimited" mobile plans (Airtel throttles to 256 kbps after 40/65/100 GB) and Starlink has a 1 TB fair-use (Source: [Mobility.com.ng, Feb 2026](https://mobility.com.ng/best-data-plans-in-nigeria-2026-updated-prices/)).
- Own test: on an Airtel router in Lagos, download dropped from 19.75 Mbps to 3.78 Mbps within about 10 minutes; one TLS setup took 2.6 s; Cloudflare served the same IP from Paris (CDG) for one hostname and Lagos (LOS) for another; ICMP to huggingface.co had a 220 ms spike against a 36 ms average; traceroute shows carrier-grade NAT (Source: my measurement, 22 Oct 2026, 14:17 to 14:29 UTC).

### Inferences
- Carrier-grade NAT plus mobile handovers means long-lived TCP connections can be reset; a single non-resumable 300 MB upload over 10 to 25 minutes on a weak connection has a real chance of failing. Use chunked, resumable uploads (e.g. tus or S3 multipart with 5 to 10 MB parts and retry) and HTTP range requests for downloads.
- Data-depletion anxiety is a live public issue in Nigeria (23,400 complaints in H1 2026), so showing file size and MB cost before a large transfer is likely to be valued.

### Gaps
- No Nairaland, Reddit or X threads were found that document 100 to 200 MB downloads failing specifically; the search returned nothing relevant. This remains unverified either way.
- No evidence found of transparent carrier proxies or compression on Nigerian 4G for HTTPS traffic (Opera Mini style compression is client-side).
- No published packet-loss or connection-drop rates.

## Recommended 3 test connection profiles (synthesis)

These are inferences built from the cited numbers above. RTT is to the app origin or API (not to a Lagos speed-test server). USD at NGN 1,333.

| | Profile 1: "Peak-hour budget 4G" (bad) | Profile 2: "Typical Lagos 4G" (median) | Profile 3: "Good Wi-Fi" (5G router / fibre / Starlink) |
|---|---|---|---|
| Download | 3 Mbps | 15 Mbps | 40 Mbps |
| Upload | 1 Mbps | 5 Mbps | 15 Mbps |
| RTT | 250 ms (spikes to 600 ms) | 100 ms (spikes to 250 ms) | 40 ms |
| Loss / drops | 2% loss; throughput swings 1 to 5 Mbps; a 15 to 30 s stall about every 5 min; one connection reset per 10 to 15 min | 0.5% loss; throughput swings plus or minus 50% over minutes; occasional 5 to 10 s stall | about 0% loss; rare stalls; FUP not reached |
| Evidence | T2 upload 1.9, Airtel upload 4.3 Mbps; Airtel consistent quality 6.9%; 41% of connections on 2G/3G; peak-hour congestion and fibre cuts; my 3.78 Mbps low | Opensignal MTN 21.3/7.9, Airtel 14.2/4.3, Glo 13.0/5.0; nPerf MTN 18.7/8.7, Airtel 10.6/4.7 | Ookla fixed median 36.77/22.45 Mbps, 23 ms; Airtel SmartConnect 50 Mbps tier; my Airtel router test 14 to 20 down, 7.5 to 9 up |
| Cost per GB | NGN 667 (USD 0.50) on a 1.5 GB weekly bundle; NGN 3,070 to 4,600 (USD 2.30 to 3.45) pay-as-you-go when the bundle runs out | NGN 333 to 450 (USD 0.25 to 0.34) on Airtel 12 GB / MTN 10 GB monthly | Flat: Airtel 5G NGN 25,000/mo (USD 18.76) or Starlink NGN 57,000/mo (USD 42.76); marginal cost about NGN 0/GB |
| Cost of one 300 MB upload | about NGN 200 (USD 0.15), or about NGN 920 to 1,380 PAYG | about NGN 100 to 135 (USD 0.08 to 0.10) | about NGN 0 |
| Time for 300 MB up / 200 MB down (ideal) | about 40 min / 9 min | about 8 min / 1.8 min | about 2.7 min / 40 s |
| Typical device | Tecno Pop 10 or itel A90: 3 to 4 GB RAM, Unisoc T7250/T7100, Android 13 to 15, 720p, 360x800 viewport | Tecno Spark 40 / Infinix Hot 60 / Redmi 14C / Samsung Galaxy A-series: 4 to 8 GB, Helio G81-class | UK-used iPhone 11/12/13 (4 GB RAM) or a laptop (desktop is 24% of Nigerian web traffic) |
| Typical browser | Chrome Android, or Opera / Opera Mini | Chrome Android (68%) | Safari iOS (11%) or desktop Chrome |

### Gaps
- Exact per-GB figures assume Feb 2026 list prices; Oct 2026 prices were not verified on operator websites.
- Packet-loss and drop-frequency values in the profiles are judgement calls from qualitative evidence, not measured national statistics.
