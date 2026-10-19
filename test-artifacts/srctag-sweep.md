# srctag sweep over the live table

Recorded 2026-10-19 by `test/srctag-cdp.test.ts` against the running app on `localhost:5173`.
Rows, channel sets and dates come from that page’s own IndexedDB, so the numbers are
this table’s, not a fixture’s. Re-record with:

```sh
npx vitest run test/srctag-cdp.test.ts --reporter=verbose --silent=false
```

## static channels over 1499 live rows · priority from pin cards (1) (23 tags)

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tfidf | tid | 1499 | 879 | 620 | 1660 | 552 | 0.470 | 0.960 | 949 | 1.000 | 533ms | priority 0.61 · keyword 0.30 · tfidf 0.09 |
| textrank | tid | 1499 | 1498 | 1 | 10395 | 5292 | 0.913 | 2.186 | 305 | 0.074 | 1747ms | textRank 0.90 · clusterRank 0.08 · priority 0.02 · keyword 0.01 |
| textrank@visitTime | visitTime | 1499 | 1498 | 1 | 10396 | 5283 | 0.915 | 2.187 | 306 | 0.074 | 2254ms | textRank 0.89 · clusterRank 0.08 · priority 0.02 · keyword 0.01 |
| textrank@dt | dt | 1499 | 1498 | 1 | 10396 | 5279 | 0.914 | 2.187 | 307 | 0.074 | 2442ms | textRank 0.89 · clusterRank 0.08 · priority 0.02 · keyword 0.01 |
| textrank@domain | domain | 1499 | 1498 | 1 | 10396 | 4837 | 0.973 | 2.250 | 240 | 0.079 | 2997ms | textRank 0.83 · clusterRank 0.16 · priority 0.01 · keyword 0.00 |
| hybrid | visitTime | 1499 | 1498 | 1 | 10391 | 5217 | 0.483 | 1.381 | 804 | 0.077 | 7261ms | textRank 0.81 · clusterRank 0.09 · priority 0.06 · keyword 0.03 · tfidf 0.01 |
| rstext | domain | 1499 | 1498 | 1 | 6844 | 2684 | 0.696 | 1.750 | 720 | 0.094 | 1356ms | textRank 0.67 · clusterRank 0.22 · priority 0.08 · keyword 0.03 |
| rstext+embed | domain | 24 | 23 | 1 | 153 | 115 | 0.425 | 1.000 | 20 | 0.000 | 30ms | textRank 0.68 · clusterRank 0.14 · priority 0.12 · keyword 0.06 |
| hybrid+embed+classify | visitTime | 24 | 23 | 1 | 153 | 126 | 0.305 | 0.778 | 21 | 0.000 | 43ms | textRank 0.73 · priority 0.14 · keyword 0.06 · clusterRank 0.06 · tfidf 0.02 |

## hyperparameters around the rstext preset, 1499 live rows

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rstext anchor | domain | 1499 | 1498 | 1 | 6844 | 2684 | 0.696 | 1.750 | 720 | 0.000 | 5615ms | textRank 0.67 · clusterRank 0.22 · priority 0.08 · keyword 0.03 |
| topK 4 | domain | 1499 | 1498 | 1 | 5669 | 2019 | 0.721 | 1.750 | 711 | 0.752 | 3656ms | textRank 0.64 · clusterRank 0.24 · priority 0.09 · keyword 0.04 |
| topK 16 | domain | 1499 | 1498 | 1 | 13268 | 6703 | 0.610 | 1.750 | 726 | 0.400 | 5897ms | textRank 0.78 · clusterRank 0.15 · priority 0.04 · keyword 0.02 |
| minScore 0.02 | domain | 1499 | 1498 | 1 | 7076 | 2825 | 0.684 | 1.750 | 720 | 0.950 | 2790ms | textRank 0.68 · clusterRank 0.22 · priority 0.07 · keyword 0.03 |
| minScore 0.2 | domain | 1499 | 1498 | 1 | 7074 | 2825 | 0.684 | 1.750 | 720 | 0.950 | 5683ms | textRank 0.68 · clusterRank 0.22 · priority 0.07 · keyword 0.03 |
| minScore 0.7 | domain | 1499 | 1313 | 186 | 2954 | 310 | 0.852 | 1.750 | 720 | 0.115 | 4042ms | textRank 0.47 · clusterRank 0.33 · priority 0.14 · keyword 0.06 |
| window 2 | domain | 1499 | 1498 | 1 | 6830 | 2733 | 0.694 | 1.750 | 746 | 0.924 | 1813ms | textRank 0.67 · clusterRank 0.21 · priority 0.08 · keyword 0.03 |
| window 8 | domain | 1499 | 1498 | 1 | 6849 | 2668 | 0.693 | 1.650 | 710 | 0.938 | 3624ms | textRank 0.68 · clusterRank 0.22 · priority 0.07 · keyword 0.03 |
| rank window 2 | domain | 1499 | 1498 | 1 | 6704 | 2538 | 0.698 | 1.750 | 788 | 0.455 | 1257ms | textRank 0.66 · clusterRank 0.22 · priority 0.08 · keyword 0.04 |
| rank window 8 | domain | 1499 | 1498 | 1 | 6781 | 2670 | 0.711 | 1.750 | 681 | 0.529 | 3172ms | textRank 0.68 · clusterRank 0.22 · priority 0.07 · keyword 0.03 |
| damping 0.5 | domain | 1499 | 1498 | 1 | 7009 | 2574 | 0.726 | 1.750 | 438 | 0.833 | 2002ms | textRank 0.69 · clusterRank 0.25 · priority 0.04 · keyword 0.02 |
| damping 0.95 | domain | 1499 | 1498 | 1 | 6814 | 2771 | 0.690 | 1.750 | 728 | 0.921 | 2881ms | textRank 0.68 · clusterRank 0.21 · priority 0.08 · keyword 0.03 |
| no clusterRank | domain | 1499 | 1498 | 1 | 6563 | 3571 | 0.593 | 1.350 | 947 | 0.722 | 921ms | textRank 0.82 · priority 0.12 · keyword 0.06 |
| no turboText | domain | 1499 | 1498 | 1 | 6807 | 2754 | 0.675 | 1.000 | 104 | 0.966 | 1982ms | textRank 0.74 · clusterRank 0.26 |
| tfidf back on | domain | 1499 | 1498 | 1 | 6961 | 2813 | 0.740 | 1.943 | 685 | 0.939 | 2037ms | textRank 0.64 · clusterRank 0.20 · tfidf 0.07 · priority 0.07 · keyword 0.03 |
| burstGap 60s | domain | 1499 | 1498 | 1 | 6844 | 2684 | 0.696 | 1.750 | 720 | 1.000 | 3207ms | textRank 0.67 · clusterRank 0.22 · priority 0.08 · keyword 0.03 |

## aim pass over 1499 live rows · priority from pin cards (1) (23 tags)

| case | aimMin | promote | rows | untagged | prio | focus/row | tags/row | sub rows | sub tags | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off | 0.40 | 3 | 1499 | 1 | 678 | 4.46 | 4.46 | 0 | 0 | 0ms |
| aimMin 0.2 | 0.20 | 3 | 1499 | 1 | 678 | 4.46 | 4.73 | 281 | 34 | 37ms |
| aimMin 0.4 | 0.40 | 3 | 1499 | 1 | 678 | 4.46 | 4.73 | 281 | 34 | 22ms |
| aimMin 0.7 | 0.70 | 3 | 1499 | 313 | 678 | 1.59 | 1.99 | 359 | 36 | 21ms |
| promoteMin 2 | 0.40 | 2 | 1499 | 1 | 678 | 4.46 | 5.07 | 528 | 132 | 12ms |
| promoteMin 3 | 0.40 | 3 | 1499 | 1 | 678 | 4.46 | 4.73 | 281 | 34 | 14ms |
| promoteMin 4 | 0.40 | 4 | 1499 | 1 | 678 | 4.46 | 4.61 | 143 | 12 | 21ms |

## rrf stages over the newest 600 of 1499 live rows · priority from pin cards (1) (23 tags)

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| preset | anchor | 600 | 599 | 1 | 2202 | 1501 | 1.983 | 34.000 | 79 | 12 | 1.000 | 760ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 30 · md 29 · seer 23 · 千问 15 |
| urls on | bm25f | 600 | 600 | 0 | 3162 | 1405 | 1.922 | 31.000 | 230 | 38 | 0.500 | 1278ms | bm25,clusterRank,group,priority,textRank | google 165 · gx 162 · opera 160 · youtube 125 · chat 93 · utf 93 |
| k1 0.5 | bm25f | 600 | 599 | 1 | 2232 | 1512 | 0.933 | 7.000 | 94 | 17 | 0.963 | 573ms | bm25,clusterRank,group,priority,textRank | youtube 129 · 千问 37 · ai 31 · 博正 30 · md 29 · seer 23 |
| k1 3 | bm25f | 600 | 599 | 1 | 2232 | 1510 | 0.928 | 7.000 | 94 | 17 | 0.960 | 547ms | bm25,clusterRank,group,priority,textRank | youtube 129 · 千问 37 · ai 31 · 博正 30 · md 29 · seer 23 |
| b 0 | bm25f | 600 | 599 | 1 | 2232 | 1515 | 0.934 | 7.000 | 94 | 17 | 0.965 | 1053ms | bm25,clusterRank,group,priority,textRank | youtube 129 · 千问 37 · ai 31 · 博正 30 · md 29 · seer 23 |
| b 1 | bm25f | 600 | 599 | 1 | 2232 | 1511 | 0.927 | 7.000 | 94 | 17 | 0.967 | 889ms | bm25,clusterRank,group,priority,textRank | youtube 129 · 千问 37 · ai 31 · 博正 30 · md 29 · seer 23 |
| title only | bm25f | 600 | 592 | 8 | 2068 | 1490 | 0.594 | 7.000 | 20 | 4 | 0.986 | 478ms | bm25,clusterRank,group,priority,textRank | youtube 43 · ai 32 · 博正 21 · seer 16 · 千问 15 · com 12 |
| tags only | bm25f | 600 | 555 | 45 | 1169 | 45 | 106.233 | 189.000 | 510 | 23 | 0.013 | 582ms | bm25,clusterRank,group,priority,textRank | dup 412 · rejected 401 · AI 86 · suffix_DeepSeek 45 · suffix_GoogleSearch 41 · md 32 |
| url field back | bm25f | 600 | 599 | 1 | 2232 | 1511 | 0.934 | 7.000 | 94 | 17 | 0.970 | 700ms | bm25,clusterRank,group,priority,textRank | youtube 129 · 千问 37 · ai 31 · 博正 30 · md 29 · seer 23 |
| k 1 | fusion | 600 | 587 | 13 | 934 | 443 | 4.215 | 34.000 | 132 | 12 | 0.283 | 471ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 69 · fixmechange 60 · AI 30 · 博正 30 · md 28 |
| k 10 | fusion | 600 | 598 | 2 | 1971 | 1348 | 2.107 | 34.000 | 79 | 12 | 0.862 | 536ms | bm25,clusterRank,group,priority,textRank | youtube 129 · 博正 30 · md 28 · ai 25 · seer 23 · 千问 15 |
| k 200 | fusion | 600 | 599 | 1 | 2202 | 1501 | 1.996 | 34.000 | 79 | 12 | 0.970 | 742ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 33 · 博正 30 · md 29 · seer 23 · 千问 15 |
| maxDf 1 (floor off) | global | 600 | 599 | 1 | 2202 | 1501 | 1.983 | 34.000 | 79 | 12 | 1.000 | 580ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 30 · md 29 · seer 23 · 千问 15 |
| maxDf 0.2 | global | 600 | 591 | 9 | 2067 | 1493 | 0.593 | 7.000 | 20 | 4 | 0.993 | 543ms | bm25,clusterRank,group,priority,textRank | youtube 43 · ai 31 · 博正 21 · seer 16 · 千问 15 · com 12 |
| stop off | global | 600 | 599 | 1 | 2224 | 1505 | 1.970 | 34.000 | 79 | 12 | 0.962 | 640ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 30 · md 29 · seer 23 · vs 20 |
| stop + maxDf 1 | global | 600 | 599 | 1 | 2224 | 1505 | 1.970 | 34.000 | 79 | 12 | 0.962 | 703ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 30 · md 29 · seer 23 · vs 20 |
| no bm25 | signals | 600 | 545 | 55 | 1073 | 131 | 1.986 | 7.000 | 336 | 8 | 0.074 | 770ms | clusterRank,group,priority,textRank | access 278 · telegram 278 · AI 67 · youtube 42 · suffix_DeepSeek 30 · 博正 19 |
| no priority | signals | 600 | 597 | 3 | 2724 | 1511 | 1.886 | 34.000 | 78 | 12 | 0.987 | 663ms | bm25,clusterRank,group,textRank | dup 164 · youtube 129 · fixed 112 · merged 107 · fixmechange 96 · ai 32 |
| no graph | signals | 600 | 598 | 2 | 2748 | 1556 | 1.651 | 34.000 | 87 | 16 | 0.798 | 264ms | bm25,group,priority | dup 176 · youtube 125 · fixed 115 · merged 109 · fixmechange 98 · AI 38 |
| no buckets | buckets | 600 | 598 | 2 | 2574 | 1500 | 0.493 | 1.000 | 0 | 0 | 0.987 | 652ms | bm25,clusterRank,priority,textRank | dup 152 · fixed 112 · merged 107 · fixmechange 96 · youtube 43 · ai 32 |
| mmr λ 0 | buckets | 600 | 599 | 1 | 2202 | 1501 | 2.003 | 35.000 | 79 | 12 | 0.997 | 517ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 30 · md 29 · seer 23 · 千问 15 |
| mmr λ 1 | buckets | 600 | 599 | 1 | 2202 | 1501 | 1.983 | 34.000 | 79 | 12 | 1.000 | 679ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 30 · md 29 · seer 23 · 千问 15 |
| graph λ 0 | buckets | 600 | 599 | 1 | 2202 | 1501 | 1.983 | 34.000 | 79 | 12 | 0.999 | 685ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 30 · md 29 · seer 23 · 千问 15 |
| promote ≥ 2 | buckets | 600 | 599 | 1 | 2332 | 1543 | 1.972 | 34.000 | 163 | 54 | 0.972 | 584ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 44 · 博正 34 · 千问 31 · md 29 · seer 25 |
| promote ≥ 5 | buckets | 600 | 599 | 1 | 2157 | 1495 | 1.944 | 34.000 | 63 | 6 | 0.996 | 682ms | bm25,clusterRank,group,priority,textRank | youtube 129 · ai 31 · 博正 18 · seer 16 · 千问 15 · com 12 |
| themes ≤ 1 | buckets | 600 | 599 | 1 | 2123 | 1495 | 1.295 | 34.000 | 79 | 6 | 0.996 | 576ms | bm25,clusterRank,group,priority,textRank | youtube 86 · ai 31 · 博正 21 · md 20 · seer 16 · 千问 15 |

## qarf alpha over the newest 600 of 1499 live rows · priority from pin cards (1) (23 tags)

| case | rows | empty | sugg | dist | λ̄ | σλ | λ clip | sub rows | sub tags | jaccard | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| α 0 (= rrf) | 600 | 1 | 2202 | 1501 | 0.667 | 0.000 | 0.00 | 79 | 12 | 1.000 | 560 |
| α 0.5 | 600 | 1 | 2111 | 1495 | 0.567 | 0.165 | 0.00 | 40 | 10 | 0.952 | 726 |
| α 1 (default) | 600 | 1 | 2124 | 1482 | 0.516 | 0.221 | 0.13 | 46 | 12 | 0.918 | 765 |
| α 2 | 600 | 1 | 2119 | 1474 | 0.470 | 0.270 | 0.22 | 36 | 9 | 0.859 | 1550 |
| α 4 | 600 | 1 | 2192 | 1467 | 0.443 | 0.314 | 0.40 | 36 | 9 | 0.824 | 699 |
| α 1, clip 0.2/0.8 | 600 | 1 | 2219 | 1485 | 0.530 | 0.195 | 0.16 | 89 | 15 | 0.920 | 866 |
| α 1, clip 0.01/0.99 | 600 | 1 | 2123 | 1481 | 0.508 | 0.237 | 0.01 | 46 | 12 | 0.918 | 837 |
| α 1, floor 0.3 | 600 | 1 | 2223 | 1488 | 0.549 | 0.166 | 0.21 | 89 | 16 | 0.922 | 960 |
| α 1, ceil 0.7 | 600 | 1 | 2123 | 1482 | 0.510 | 0.214 | 0.31 | 46 | 12 | 0.910 | 2381 |
| α 0.5, clip 0.2/0.8 | 600 | 1 | 2206 | 1498 | 0.571 | 0.155 | 0.09 | 83 | 13 | 0.954 | 804 |
| α 1, no burst | 600 | 1 | 2124 | 1482 | 0.516 | 0.221 | 0.13 | 46 | 12 | 0.918 | 1482 |

## rrf over the 398 live rows carrying suffix_GoogleSearch · the pattern every row of the list repeats

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| urls on, w url 1 | filtered | 398 | 398 | 0 | 2407 | 789 | 10.230 | 101.000 | 214 | 15 | 1.000 | 1659ms | bm25,clusterRank,group,priority,textRank | gx 432 · opera 308 · google 257 · utf 221 · gws 136 · serp 55 |
| urls off, w url 1 | filtered | 398 | 394 | 4 | 1642 | 1421 | 0.535 | 3.000 | 6 | 3 | 0.429 | 468ms | bm25,clusterRank,group,priority,textRank | database 9 · ai 7 · convexity 6 · risk 6 · index 5 · macro 5 |
| urls off, w url 0 | filtered | 398 | 394 | 4 | 1642 | 1422 | 0.535 | 3.000 | 6 | 3 | 0.429 | 337ms | bm25,clusterRank,group,priority,textRank | ideas 9 · ai 7 · convexity 6 · risk 6 · index 5 · macro 5 |
| urls off, w url 0, floor on | filtered | 398 | 394 | 4 | 1642 | 1422 | 0.535 | 3.000 | 6 | 3 | 0.429 | 352ms | bm25,clusterRank,group,priority,textRank | ideas 9 · ai 7 · convexity 6 · risk 6 · index 5 · macro 5 |
| urls off, w url 0, floor on, f= named | filtered | 398 | 394 | 4 | 1638 | 1420 | 0.535 | 3.000 | 6 | 3 | 0.429 | 395ms | bm25,clusterRank,group,priority,textRank | ideas 9 · ai 7 · convexity 6 · index 6 · risk 6 · macro 5 |

## aim pass

![aim pass](srctag-sweep.svg)
