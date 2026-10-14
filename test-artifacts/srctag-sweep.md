# srctag sweep over the live table

Recorded 2026-10-14 by `test/srctag-cdp.test.ts` against the running app on `localhost:5173`.
Rows, channel sets and dates come from that page’s own IndexedDB, so the numbers are
this table’s, not a fixture’s. Re-record with:

```sh
npx vitest run test/srctag-cdp.test.ts --reporter=verbose --silent=false
```

## static channels over 1499 live rows · priority from pin cards (1) (22 tags)

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tfidf | tid | 1499 | 411 | 1088 | 1099 | 564 | 0.301 | 0.958 | 342 | 1.000 | 220ms | priority 0.52 · keyword 0.26 · tfidf 0.22 |
| textrank | tid | 1499 | 1499 | 0 | 10635 | 4899 | 0.909 | 2.250 | 210 | 0.085 | 1261ms | textRank 0.90 · clusterRank 0.08 · priority 0.01 · keyword 0.01 |
| textrank@visitTime | visitTime | 1499 | 1499 | 0 | 10636 | 4893 | 0.909 | 2.250 | 210 | 0.084 | 1792ms | textRank 0.90 · clusterRank 0.08 · priority 0.01 · keyword 0.01 |
| textrank@dt | dt | 1499 | 1499 | 0 | 10636 | 4892 | 0.909 | 2.250 | 210 | 0.084 | 951ms | textRank 0.90 · clusterRank 0.08 · priority 0.01 · keyword 0.01 |
| textrank@domain | domain | 1499 | 1499 | 0 | 10636 | 4462 | 0.992 | 2.250 | 209 | 0.090 | 714ms | textRank 0.81 · clusterRank 0.17 · priority 0.01 · keyword 0.00 |
| hybrid | visitTime | 1499 | 1499 | 0 | 10632 | 4874 | 0.474 | 1.421 | 311 | 0.087 | 891ms | textRank 0.85 · clusterRank 0.09 · priority 0.02 · tfidf 0.01 · keyword 0.01 |
| rstext | domain | 1499 | 1499 | 0 | 6969 | 2479 | 0.709 | 1.750 | 285 | 0.105 | 645ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| rstext+embed | domain | 24 | 24 | 0 | 126 | 97 | 0.430 | 1.300 | 5 | 0.000 | 11ms | textRank 0.78 · clusterRank 0.16 · priority 0.04 · keyword 0.02 |
| hybrid+embed+classify | visitTime | 24 | 24 | 0 | 126 | 102 | 0.303 | 0.750 | 5 | 0.000 | 12ms | textRank 0.84 · clusterRank 0.08 · priority 0.04 · keyword 0.02 · tfidf 0.02 |

## hyperparameters around the rstext preset, 1499 live rows

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rstext anchor | domain | 1499 | 1499 | 0 | 6969 | 2479 | 0.709 | 1.750 | 285 | 0.000 | 657ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| topK 4 | domain | 1499 | 1499 | 0 | 5739 | 1905 | 0.736 | 1.750 | 283 | 0.768 | 703ms | textRank 0.67 · clusterRank 0.28 · priority 0.03 · keyword 0.02 |
| topK 16 | domain | 1499 | 1499 | 0 | 13627 | 6200 | 0.620 | 1.750 | 285 | 0.400 | 683ms | textRank 0.79 · clusterRank 0.19 · priority 0.02 · keyword 0.01 |
| minScore 0.02 | domain | 1499 | 1499 | 0 | 7184 | 2604 | 0.698 | 1.750 | 285 | 0.952 | 635ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| minScore 0.2 | domain | 1499 | 1499 | 0 | 7182 | 2603 | 0.698 | 1.750 | 285 | 0.952 | 641ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| minScore 0.7 | domain | 1499 | 1274 | 225 | 3035 | 419 | 0.872 | 1.750 | 285 | 0.169 | 629ms | textRank 0.54 · clusterRank 0.38 · priority 0.05 · keyword 0.03 |
| window 2 | domain | 1499 | 1499 | 0 | 6964 | 2548 | 0.704 | 1.750 | 284 | 0.924 | 476ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| window 8 | domain | 1499 | 1499 | 0 | 6978 | 2465 | 0.706 | 1.750 | 289 | 0.938 | 977ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| rank window 2 | domain | 1499 | 1499 | 0 | 6849 | 2381 | 0.712 | 1.750 | 290 | 0.449 | 582ms | textRank 0.69 · clusterRank 0.27 · priority 0.03 · keyword 0.01 |
| rank window 8 | domain | 1499 | 1499 | 0 | 6903 | 2464 | 0.725 | 1.750 | 297 | 0.519 | 976ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| damping 0.5 | domain | 1499 | 1499 | 0 | 7125 | 2398 | 0.745 | 1.750 | 274 | 0.842 | 452ms | textRank 0.69 · clusterRank 0.27 · priority 0.03 · keyword 0.01 |
| damping 0.95 | domain | 1499 | 1499 | 0 | 6931 | 2560 | 0.703 | 1.750 | 286 | 0.915 | 789ms | textRank 0.70 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |
| no clusterRank | domain | 1499 | 1499 | 0 | 6520 | 3399 | 0.576 | 1.350 | 342 | 0.693 | 271ms | textRank 0.93 · priority 0.05 · keyword 0.02 |
| no turboText | domain | 1499 | 1499 | 0 | 6949 | 2523 | 0.689 | 1.000 | 114 | 0.979 | 640ms | textRank 0.73 · clusterRank 0.27 |
| tfidf back on | domain | 1499 | 1499 | 0 | 7066 | 2594 | 0.762 | 1.916 | 273 | 0.944 | 633ms | textRank 0.65 · clusterRank 0.24 · tfidf 0.08 · priority 0.03 · keyword 0.01 |
| burstGap 60s | domain | 1499 | 1499 | 0 | 6969 | 2479 | 0.709 | 1.750 | 285 | 1.000 | 642ms | textRank 0.69 · clusterRank 0.26 · priority 0.03 · keyword 0.01 |

## aim pass over 1499 live rows · priority from pin cards (1) (22 tags)

| case | aimMin | promote | rows | untagged | prio | focus/row | tags/row | sub rows | sub tags | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off | 0.40 | 3 | 1499 | 0 | 265 | 4.48 | 4.48 | 0 | 0 | 0ms |
| aimMin 0.2 | 0.20 | 3 | 1499 | 0 | 265 | 4.48 | 5.21 | 635 | 78 | 6ms |
| aimMin 0.4 | 0.40 | 3 | 1499 | 0 | 265 | 4.48 | 5.21 | 635 | 78 | 7ms |
| aimMin 0.7 | 0.70 | 3 | 1499 | 5 | 265 | 0.95 | 2.37 | 1154 | 56 | 5ms |
| promoteMin 2 | 0.40 | 2 | 1499 | 0 | 265 | 4.48 | 5.61 | 895 | 246 | 4ms |
| promoteMin 3 | 0.40 | 3 | 1499 | 0 | 265 | 4.48 | 5.21 | 635 | 78 | 3ms |
| promoteMin 4 | 0.40 | 4 | 1499 | 0 | 265 | 4.48 | 5.02 | 474 | 41 | 3ms |

## rrf stages over the newest 600 of 1499 live rows · priority from pin cards (1) (22 tags)

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| preset | anchor | 600 | 591 | 9 | 2341 | 1629 | 0.675 | 5.000 | 71 | 15 | 1.000 | 156ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| urls on | bm25f | 600 | 599 | 1 | 3313 | 1502 | 2.339 | 38.000 | 256 | 32 | 0.524 | 286ms | bm25,clusterRank,group,priority,textRank | google 191 · gx 161 · opera 115 · ai 114 · gemini 102 · utf 96 |
| k1 0.5 | bm25f | 600 | 591 | 9 | 2460 | 1649 | 0.836 | 8.000 | 118 | 26 | 0.957 | 167ms | bm25,clusterRank,group,priority,textRank | ai 110 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| k1 3 | bm25f | 600 | 591 | 9 | 2458 | 1645 | 0.835 | 8.000 | 117 | 26 | 0.958 | 164ms | bm25,clusterRank,group,priority,textRank | ai 108 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| b 0 | bm25f | 600 | 591 | 9 | 2458 | 1649 | 0.835 | 8.000 | 117 | 26 | 0.956 | 174ms | bm25,clusterRank,group,priority,textRank | ai 108 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| b 1 | bm25f | 600 | 591 | 9 | 2460 | 1648 | 0.837 | 8.000 | 118 | 26 | 0.956 | 177ms | bm25,clusterRank,group,priority,textRank | ai 110 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| title only | bm25f | 600 | 591 | 9 | 2328 | 1629 | 0.662 | 5.000 | 71 | 14 | 0.998 | 151ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 26 · 前消 16 · youtube 13 · 匙補 12 · com 11 |
| tags only | bm25f | 600 | 595 | 5 | 1233 | 16 | 11.348 | 14.000 | 565 | 6 | 0.007 | 155ms | bm25,clusterRank,group,priority,textRank | com 499 · youtube 499 · AI 161 · deepseek 39 · md 11 · LLM 6 |
| url field back | bm25f | 600 | 591 | 9 | 2460 | 1647 | 0.837 | 8.000 | 118 | 26 | 0.958 | 185ms | bm25,clusterRank,group,priority,textRank | ai 110 · deepseek 39 · youtube 39 · md 33 · 千问 30 · google 19 |
| k 1 | fusion | 600 | 600 | 0 | 888 | 450 | 1.301 | 5.000 | 132 | 12 | 0.269 | 146ms | bm25,clusterRank,group,priority,textRank | ai 116 · sleep 85 · AI 41 · deepseek 25 · 前消 15 · youtube 13 |
| k 10 | fusion | 600 | 590 | 10 | 2066 | 1474 | 0.595 | 5.000 | 53 | 12 | 0.869 | 147ms | bm25,clusterRank,group,priority,textRank | ai 54 · deepseek 25 · 前消 16 · youtube 13 · 匙補 12 · md 11 |
| k 200 | fusion | 600 | 591 | 9 | 2341 | 1632 | 0.689 | 5.000 | 71 | 15 | 0.987 | 134ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| maxDf 1 (floor off) | global | 600 | 591 | 9 | 2341 | 1629 | 0.675 | 5.000 | 71 | 15 | 1.000 | 125ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| maxDf 0.2 | global | 600 | 591 | 9 | 2341 | 1629 | 0.675 | 5.000 | 71 | 15 | 1.000 | 139ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| stop off | global | 600 | 591 | 9 | 2359 | 1630 | 0.675 | 5.000 | 71 | 15 | 0.963 | 140ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · vs 14 · youtube 13 · dsh 12 |
| stop + maxDf 1 | global | 600 | 591 | 9 | 2359 | 1630 | 0.675 | 5.000 | 71 | 15 | 0.963 | 134ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · vs 14 · youtube 13 · dsh 12 |
| no bm25 | signals | 600 | 597 | 3 | 1306 | 151 | 3.635 | 7.000 | 437 | 11 | 0.087 | 142ms | clusterRank,group,priority,textRank | sleep 360 · use 358 · AI 161 · deepseek 39 · wasgs 21 · 前消 12 |
| no priority | signals | 600 | 591 | 9 | 2318 | 1634 | 0.893 | 5.000 | 60 | 13 | 0.994 | 140ms | bm25,clusterRank,group,textRank | ai 81 · 前消 16 · dsh 14 · youtube 13 · 匙補 12 · com 11 |
| no graph | signals | 600 | 591 | 9 | 2293 | 1694 | 0.573 | 5.000 | 43 | 9 | 0.801 | 57ms | bm25,group,priority | AI 46 · ai 31 · deepseek 25 · 前消 16 · youtube 13 · md 11 |
| no buckets | buckets | 600 | 591 | 9 | 2239 | 1614 | 0.541 | 1.000 | 0 | 0 | 0.991 | 147ms | bm25,clusterRank,priority,textRank | ai 49 · deepseek 13 · youtube 13 · com 11 · md 11 · 千问 10 |
| mmr λ 0 | buckets | 600 | 591 | 9 | 2341 | 1629 | 0.675 | 5.000 | 71 | 15 | 1.000 | 143ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| mmr λ 1 | buckets | 600 | 591 | 9 | 2341 | 1629 | 0.675 | 5.000 | 71 | 15 | 1.000 | 140ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| graph λ 0 | buckets | 600 | 591 | 9 | 2341 | 1629 | 0.675 | 5.000 | 71 | 15 | 1.000 | 125ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 39 · 前消 16 · youtube 13 · dsh 12 · 匙補 12 |
| promote ≥ 2 | buckets | 600 | 591 | 9 | 2463 | 1670 | 0.734 | 5.000 | 133 | 56 | 0.973 | 130ms | bm25,clusterRank,group,priority,textRank | ai 111 · deepseek 39 · 前消 16 · youtube 13 · api 12 · dsh 12 |
| promote ≥ 5 | buckets | 600 | 591 | 9 | 2267 | 1618 | 0.596 | 5.000 | 23 | 4 | 0.993 | 127ms | bm25,clusterRank,group,priority,textRank | ai 49 · deepseek 26 · 前消 16 · youtube 13 · com 11 · md 11 |
| themes ≤ 1 | buckets | 600 | 591 | 9 | 2310 | 1623 | 0.638 | 5.000 | 71 | 9 | 0.996 | 130ms | bm25,clusterRank,group,priority,textRank | ai 80 · deepseek 26 · youtube 13 · com 11 · md 11 · 前消 11 |

## rrf over the 377 live rows carrying suffix_GoogleSearch · the pattern every row of the list repeats

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| urls on, w url 1 | filtered | 377 | 377 | 0 | 2347 | 706 | 14.752 | 120.000 | 235 | 15 | 1.000 | 339ms | bm25,clusterRank,group,priority,textRank | gx 461 · opera 290 · google 270 · utf 227 · gws 129 · serp 42 |
| urls off, w url 1 | filtered | 377 | 374 | 3 | 1574 | 1256 | 0.543 | 4.000 | 7 | 3 | 0.439 | 154ms | bm25,clusterRank,group,priority,textRank | database 12 · risk 7 · convexity 6 · macro 5 · system 5 · 3d 4 |
| urls off, w url 0 | filtered | 377 | 374 | 3 | 1574 | 1259 | 0.544 | 4.000 | 7 | 3 | 0.439 | 114ms | bm25,clusterRank,group,priority,textRank | ideas 12 · risk 7 · convexity 6 · macro 5 · 3d 4 · ai 4 |
| urls off, w url 0, floor on | filtered | 377 | 374 | 3 | 1574 | 1259 | 0.544 | 4.000 | 7 | 3 | 0.439 | 115ms | bm25,clusterRank,group,priority,textRank | ideas 12 · risk 7 · convexity 6 · macro 5 · 3d 4 · ai 4 |
| urls off, w url 0, floor on, f= named | filtered | 377 | 374 | 3 | 1570 | 1256 | 0.544 | 4.000 | 7 | 3 | 0.438 | 124ms | bm25,clusterRank,group,priority,textRank | ideas 12 · risk 7 · convexity 6 · macro 5 · 3d 4 · ai 4 |

## dynamic channels against a local provider, 24 live rows

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rstext+embed | domain | 24 | 24 | 0 | 126 | 110 | 0.849 | 1.713 | 3 | 0.000 | 72ms | embed 0.51 · textRank 0.42 · clusterRank 0.06 · priority 0.01 · keyword 0.01 |
| hybrid+embed+classify | visitTime | 24 | 24 | 0 | 141 | 112 | 0.506 | 1.034 | 3 | 0.000 | 53ms | textRank 0.47 · embed 0.45 · clusterRank 0.03 · suggest 0.03 · priority 0.01 · tfidf 0.01 · keyword 0.01 |

## aim pass

![aim pass](srctag-sweep.svg)
