# srctag sweep over the live table

Recorded 2026-10-16 by `test/srctag-cdp.test.ts` against the running app on `localhost:5173`.
Rows, channel sets and dates come from that page’s own IndexedDB, so the numbers are
this table’s, not a fixture’s. Re-record with:

```sh
npx vitest run test/srctag-cdp.test.ts --reporter=verbose --silent=false
```

## static channels over 1499 live rows · priority from pin cards (1) (23 tags)

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tfidf | tid | 1499 | 412 | 1087 | 1098 | 566 | 0.301 | 0.958 | 344 | 1.000 | 177ms | priority 0.52 · keyword 0.26 · tfidf 0.22 |
| textrank | tid | 1499 | 1499 | 0 | 10635 | 4898 | 0.908 | 2.250 | 213 | 0.085 | 804ms | textRank 0.90 · clusterRank 0.08 · priority 0.01 · keyword 0.01 |
| textrank@visitTime | visitTime | 1499 | 1499 | 0 | 10636 | 4892 | 0.908 | 2.250 | 213 | 0.085 | 906ms | textRank 0.90 · clusterRank 0.08 · priority 0.01 · keyword 0.01 |
| textrank@dt | dt | 1499 | 1499 | 0 | 10636 | 4889 | 0.908 | 2.250 | 213 | 0.085 | 759ms | textRank 0.90 · clusterRank 0.08 · priority 0.01 · keyword 0.01 |
| textrank@domain | domain | 1499 | 1499 | 0 | 10636 | 4463 | 0.991 | 2.250 | 212 | 0.090 | 667ms | textRank 0.81 · clusterRank 0.17 · priority 0.01 · keyword 0.01 |
| hybrid | visitTime | 1499 | 1499 | 0 | 10632 | 4873 | 0.474 | 1.421 | 313 | 0.088 | 840ms | textRank 0.85 · clusterRank 0.09 · priority 0.02 · tfidf 0.01 · keyword 0.01 |
| rstext | domain | 1499 | 1499 | 0 | 6964 | 2478 | 0.709 | 1.750 | 287 | 0.104 | 620ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| rstext+embed | domain | 24 | 24 | 0 | 140 | 103 | 0.388 | 1.000 | 7 | 0.000 | 45ms | textRank 0.79 · clusterRank 0.14 · priority 0.05 · keyword 0.03 |
| hybrid+embed+classify | visitTime | 24 | 24 | 0 | 140 | 106 | 0.283 | 0.750 | 7 | 0.000 | 38ms | textRank 0.82 · clusterRank 0.09 · priority 0.05 · keyword 0.03 · tfidf 0.02 |

## hyperparameters around the rstext preset, 1499 live rows

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rstext anchor | domain | 1499 | 1499 | 0 | 6964 | 2478 | 0.709 | 1.750 | 287 | 0.000 | 618ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| topK 4 | domain | 1499 | 1499 | 0 | 5737 | 1905 | 0.736 | 1.750 | 285 | 0.769 | 656ms | textRank 0.67 · clusterRank 0.28 · priority 0.03 · keyword 0.02 |
| topK 16 | domain | 1499 | 1499 | 0 | 13604 | 6190 | 0.620 | 1.750 | 287 | 0.400 | 743ms | textRank 0.79 · clusterRank 0.19 · priority 0.02 · keyword 0.01 |
| minScore 0.02 | domain | 1499 | 1499 | 0 | 7184 | 2607 | 0.698 | 1.750 | 287 | 0.951 | 759ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| minScore 0.2 | domain | 1499 | 1499 | 0 | 7179 | 2604 | 0.698 | 1.750 | 287 | 0.952 | 688ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| minScore 0.7 | domain | 1499 | 1272 | 227 | 3022 | 418 | 0.872 | 1.750 | 287 | 0.169 | 660ms | textRank 0.54 · clusterRank 0.38 · priority 0.05 · keyword 0.03 |
| window 2 | domain | 1499 | 1499 | 0 | 6959 | 2545 | 0.704 | 1.750 | 286 | 0.925 | 469ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| window 8 | domain | 1499 | 1499 | 0 | 6972 | 2463 | 0.706 | 1.750 | 292 | 0.936 | 1109ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| rank window 2 | domain | 1499 | 1499 | 0 | 6843 | 2379 | 0.711 | 1.750 | 292 | 0.449 | 463ms | textRank 0.69 · clusterRank 0.27 · priority 0.03 · keyword 0.01 |
| rank window 8 | domain | 1499 | 1499 | 0 | 6900 | 2466 | 0.724 | 1.750 | 299 | 0.519 | 899ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| damping 0.5 | domain | 1499 | 1499 | 0 | 7120 | 2395 | 0.744 | 1.750 | 276 | 0.841 | 435ms | textRank 0.69 · clusterRank 0.27 · priority 0.03 · keyword 0.01 |
| damping 0.95 | domain | 1499 | 1499 | 0 | 6925 | 2557 | 0.703 | 1.750 | 288 | 0.915 | 717ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| no clusterRank | domain | 1499 | 1499 | 0 | 6513 | 3395 | 0.576 | 1.350 | 344 | 0.694 | 279ms | textRank 0.93 · priority 0.05 · keyword 0.02 |
| no turboText | domain | 1499 | 1499 | 0 | 6941 | 2521 | 0.689 | 1.000 | 114 | 0.979 | 718ms | textRank 0.73 · clusterRank 0.27 |
| tfidf back on | domain | 1499 | 1499 | 0 | 7060 | 2593 | 0.761 | 1.916 | 275 | 0.944 | 579ms | textRank 0.65 · clusterRank 0.24 · tfidf 0.08 · priority 0.03 · keyword 0.01 |
| burstGap 60s | domain | 1499 | 1499 | 0 | 6964 | 2478 | 0.709 | 1.750 | 287 | 1.000 | 604ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |

## aim pass over 1499 live rows · priority from pin cards (1) (23 tags)

| case | aimMin | promote | rows | untagged | prio | focus/row | tags/row | sub rows | sub tags | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off | 0.40 | 3 | 1499 | 0 | 267 | 4.48 | 4.48 | 0 | 0 | 0ms |
| aimMin 0.2 | 0.20 | 3 | 1499 | 0 | 267 | 4.48 | 5.21 | 635 | 78 | 7ms |
| aimMin 0.4 | 0.40 | 3 | 1499 | 0 | 267 | 4.48 | 5.21 | 635 | 78 | 4ms |
| aimMin 0.7 | 0.70 | 3 | 1499 | 5 | 267 | 0.95 | 2.36 | 1154 | 56 | 3ms |
| promoteMin 2 | 0.40 | 2 | 1499 | 0 | 267 | 4.48 | 5.61 | 897 | 246 | 7ms |
| promoteMin 3 | 0.40 | 3 | 1499 | 0 | 267 | 4.48 | 5.21 | 635 | 78 | 3ms |
| promoteMin 4 | 0.40 | 4 | 1499 | 0 | 267 | 4.48 | 5.02 | 474 | 41 | 3ms |

## rrf stages over the newest 600 of 1499 live rows · priority from pin cards (1) (23 tags)

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| preset | anchor | 600 | 591 | 9 | 2310 | 1630 | 0.643 | 5.000 | 40 | 14 | 1.000 | 193ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · youtube 13 · com 12 · dsh 12 |
| urls on | bm25f | 600 | 599 | 1 | 3309 | 1504 | 2.475 | 38.000 | 255 | 32 | 0.525 | 335ms | bm25,clusterRank,group,priority,textRank | google 188 · gx 161 · opera 113 · ai 108 · gemini 102 · utf 96 |
| k1 0.5 | bm25f | 600 | 591 | 9 | 2398 | 1653 | 0.780 | 8.000 | 87 | 24 | 0.954 | 217ms | bm25,clusterRank,group,priority,textRank | ai 46 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| k1 3 | bm25f | 600 | 591 | 9 | 2398 | 1646 | 0.780 | 8.000 | 87 | 24 | 0.958 | 218ms | bm25,clusterRank,group,priority,textRank | ai 46 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| b 0 | bm25f | 600 | 591 | 9 | 2398 | 1654 | 0.780 | 8.000 | 87 | 24 | 0.952 | 212ms | bm25,clusterRank,group,priority,textRank | ai 46 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| b 1 | bm25f | 600 | 591 | 9 | 2398 | 1650 | 0.780 | 8.000 | 87 | 24 | 0.956 | 188ms | bm25,clusterRank,group,priority,textRank | ai 46 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| title only | bm25f | 600 | 591 | 9 | 2297 | 1630 | 0.630 | 5.000 | 40 | 13 | 0.996 | 154ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 26 · 前消 16 · youtube 13 · com 12 · 匙補 12 |
| tags only | bm25f | 600 | 595 | 5 | 1235 | 17 | 11.233 | 14.000 | 564 | 6 | 0.007 | 149ms | bm25,clusterRank,group,priority,textRank | com 496 · youtube 496 · AI 167 · deepseek 39 · md 12 · LLM 6 |
| url field back | bm25f | 600 | 591 | 9 | 2398 | 1650 | 0.780 | 8.000 | 87 | 24 | 0.957 | 189ms | bm25,clusterRank,group,priority,textRank | ai 46 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| k 1 | fusion | 600 | 600 | 0 | 874 | 453 | 1.270 | 5.000 | 117 | 11 | 0.270 | 147ms | bm25,clusterRank,group,priority,textRank | ai 99 · sleep 85 · AI 43 · deepseek 25 · 前消 15 · youtube 13 |
| k 10 | fusion | 600 | 590 | 10 | 2046 | 1478 | 0.575 | 5.000 | 36 | 11 | 0.868 | 151ms | bm25,clusterRank,group,priority,textRank | ai 35 · deepseek 25 · 前消 16 · youtube 13 · 匙補 12 · md 11 |
| k 200 | fusion | 600 | 591 | 9 | 2310 | 1633 | 0.657 | 5.000 | 40 | 14 | 0.982 | 195ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| maxDf 1 (floor off) | global | 600 | 591 | 9 | 2310 | 1630 | 0.643 | 5.000 | 40 | 14 | 1.000 | 143ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · youtube 13 · com 12 · dsh 12 |
| maxDf 0.2 | global | 600 | 591 | 9 | 2310 | 1630 | 0.643 | 5.000 | 40 | 14 | 1.000 | 142ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · youtube 13 · com 12 · dsh 12 |
| stop off | global | 600 | 591 | 9 | 2328 | 1633 | 0.643 | 5.000 | 40 | 14 | 0.963 | 166ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · vs 13 · youtube 13 · com 12 |
| stop + maxDf 1 | global | 600 | 591 | 9 | 2328 | 1633 | 0.643 | 5.000 | 40 | 14 | 0.963 | 162ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · vs 13 · youtube 13 · com 12 |
| no bm25 | signals | 600 | 597 | 3 | 1299 | 148 | 3.603 | 7.000 | 437 | 11 | 0.085 | 164ms | clusterRank,group,priority,textRank | sleep 358 · management 356 · AI 167 · deepseek 39 · wasgs 21 · 前消 12 |
| no priority | signals | 600 | 591 | 9 | 2286 | 1635 | 0.862 | 5.000 | 28 | 12 | 0.993 | 174ms | bm25,clusterRank,group,textRank | ai 47 · 前消 16 · dsh 14 · youtube 13 · com 12 · 匙補 12 |
| no graph | signals | 600 | 591 | 9 | 2278 | 1698 | 0.557 | 5.000 | 28 | 8 | 0.801 | 63ms | bm25,group,priority | AI 48 · deepseek 25 · 前消 16 · ai 14 · youtube 13 · com 11 |
| no buckets | buckets | 600 | 591 | 9 | 2239 | 1616 | 0.540 | 1.000 | 0 | 0 | 0.991 | 147ms | bm25,clusterRank,priority,textRank | ai 47 · deepseek 13 · youtube 13 · com 12 · md 11 · 千问 10 |
| mmr λ 0 | buckets | 600 | 591 | 9 | 2310 | 1630 | 0.643 | 5.000 | 40 | 14 | 1.000 | 143ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · youtube 13 · com 12 · dsh 12 |
| mmr λ 1 | buckets | 600 | 591 | 9 | 2310 | 1630 | 0.643 | 5.000 | 40 | 14 | 1.000 | 148ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · youtube 13 · com 12 · dsh 12 |
| graph λ 0 | buckets | 600 | 591 | 9 | 2310 | 1630 | 0.643 | 5.000 | 40 | 14 | 1.000 | 159ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 39 · 前消 16 · youtube 13 · com 12 · dsh 12 |
| promote ≥ 2 | buckets | 600 | 591 | 9 | 2459 | 1672 | 0.719 | 5.000 | 131 | 56 | 0.973 | 148ms | bm25,clusterRank,group,priority,textRank | ai 105 · deepseek 39 · 前消 16 · api 14 · youtube 13 · com 12 |
| promote ≥ 5 | buckets | 600 | 591 | 9 | 2267 | 1620 | 0.595 | 5.000 | 23 | 4 | 0.994 | 142ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 26 · 前消 16 · youtube 13 · com 12 · md 11 |
| themes ≤ 1 | buckets | 600 | 591 | 9 | 2279 | 1624 | 0.605 | 5.000 | 40 | 8 | 0.996 | 148ms | bm25,clusterRank,group,priority,textRank | ai 47 · deepseek 26 · youtube 13 · com 12 · md 11 · 前消 11 |

## qarf alpha over the newest 600 of 1499 live rows · priority from pin cards (1) (23 tags)

| case | rows | empty | sugg | dist | λ̄ | σλ | λ clip | sub rows | sub tags | jaccard | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| α 0 (= rrf) | 600 | 9 | 2310 | 1630 | 0.667 | 0.000 | 0.00 | 40 | 14 | 1.000 | 148 |
| α 0.5 | 600 | 9 | 2304 | 1629 | 0.591 | 0.136 | 0.02 | 37 | 12 | 0.959 | 207 |
| α 1 (default) | 600 | 9 | 2312 | 1622 | 0.541 | 0.202 | 0.06 | 41 | 14 | 0.923 | 246 |
| α 2 | 600 | 9 | 2314 | 1613 | 0.491 | 0.268 | 0.17 | 42 | 14 | 0.883 | 202 |
| α 4 | 600 | 9 | 2314 | 1612 | 0.468 | 0.315 | 0.37 | 42 | 14 | 0.844 | 208 |
| α 1, clip 0.2/0.8 | 600 | 9 | 2312 | 1621 | 0.549 | 0.186 | 0.10 | 41 | 14 | 0.925 | 211 |
| α 1, clip 0.01/0.99 | 600 | 9 | 2311 | 1621 | 0.537 | 0.210 | 0.03 | 41 | 14 | 0.923 | 187 |
| α 1, floor 0.3 | 600 | 9 | 2312 | 1622 | 0.562 | 0.163 | 0.17 | 41 | 14 | 0.925 | 200 |
| α 1, ceil 0.7 | 600 | 9 | 2312 | 1624 | 0.533 | 0.194 | 0.27 | 41 | 14 | 0.916 | 192 |
| α 0.5, clip 0.2/0.8 | 600 | 9 | 2304 | 1629 | 0.594 | 0.127 | 0.03 | 37 | 12 | 0.959 | 197 |
| α 1, no burst | 600 | 9 | 2312 | 1622 | 0.541 | 0.202 | 0.06 | 41 | 14 | 0.923 | 189 |

## rrf over the 377 live rows carrying suffix_GoogleSearch · the pattern every row of the list repeats

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| urls on, w url 1 | filtered | 377 | 377 | 0 | 2347 | 706 | 14.752 | 120.000 | 235 | 15 | 1.000 | 344ms | bm25,clusterRank,group,priority,textRank | gx 461 · opera 290 · google 270 · utf 227 · gws 129 · serp 42 |
| urls off, w url 1 | filtered | 377 | 374 | 3 | 1574 | 1256 | 0.543 | 4.000 | 7 | 3 | 0.439 | 157ms | bm25,clusterRank,group,priority,textRank | database 12 · risk 7 · convexity 6 · macro 5 · system 5 · 3d 4 |
| urls off, w url 0 | filtered | 377 | 374 | 3 | 1574 | 1259 | 0.544 | 4.000 | 7 | 3 | 0.439 | 110ms | bm25,clusterRank,group,priority,textRank | ideas 12 · risk 7 · convexity 6 · macro 5 · 3d 4 · ai 4 |
| urls off, w url 0, floor on | filtered | 377 | 374 | 3 | 1574 | 1259 | 0.544 | 4.000 | 7 | 3 | 0.439 | 131ms | bm25,clusterRank,group,priority,textRank | ideas 12 · risk 7 · convexity 6 · macro 5 · 3d 4 · ai 4 |
| urls off, w url 0, floor on, f= named | filtered | 377 | 374 | 3 | 1570 | 1256 | 0.544 | 4.000 | 7 | 3 | 0.438 | 133ms | bm25,clusterRank,group,priority,textRank | ideas 12 · risk 7 · convexity 6 · macro 5 · 3d 4 · ai 4 |

## dynamic channels against a local provider, 24 live rows

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rstext+embed | domain | 24 | 24 | 0 | 140 | 121 | 0.788 | 1.500 | 5 | 0.000 | 134ms | embed 0.53 · textRank 0.41 · clusterRank 0.04 · priority 0.02 · keyword 0.01 |
| hybrid+embed+classify | visitTime | 24 | 24 | 0 | 152 | 123 | 0.488 | 1.034 | 5 | 0.000 | 123ms | embed 0.46 · textRank 0.45 · clusterRank 0.02 · suggest 0.02 · priority 0.02 · keyword 0.01 · tfidf 0.01 |

## aim pass

![aim pass](srctag-sweep.svg)
