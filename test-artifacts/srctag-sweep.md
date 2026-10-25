# srctag sweep over the live table

Recorded 2026-10-25 by `test/srctag-cdp.test.ts` against the running app on `localhost:5173`.
Rows, channel sets and dates come from that page’s own IndexedDB, so the numbers are
this table’s, not a fixture’s. Re-record with:

```sh
npx vitest run test/srctag-cdp.test.ts --reporter=verbose --silent=false
```

## static channels over 1499 live rows · priority from pin cards (1) (13 tags)

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tfidf | tid | 1499 | 265 | 1234 | 900 | 583 | 0.199 | 0.806 | 149 | 1.000 | 905ms | priority 0.42 · tfidf 0.38 · keyword 0.21 |
| textrank | tid | 1499 | 1497 | 2 | 10294 | 4664 | 0.906 | 2.186 | 89 | 0.087 | 3291ms | textRank 0.91 · clusterRank 0.08 · priority 0.00 · keyword 0.00 |
| textrank@visitTime | visitTime | 1499 | 1497 | 2 | 10292 | 4639 | 0.909 | 2.187 | 85 | 0.086 | 2127ms | textRank 0.90 · clusterRank 0.09 · priority 0.00 · keyword 0.00 |
| textrank@dt | dt | 1499 | 1497 | 2 | 10292 | 4649 | 0.907 | 2.187 | 86 | 0.087 | 4129ms | textRank 0.91 · clusterRank 0.08 · priority 0.00 · keyword 0.00 |
| textrank@domain | domain | 1499 | 1497 | 2 | 10294 | 4210 | 0.983 | 2.154 | 81 | 0.093 | 5048ms | textRank 0.82 · clusterRank 0.17 · priority 0.00 · keyword 0.00 |
| hybrid | visitTime | 1499 | 1497 | 2 | 10288 | 4637 | 0.472 | 1.380 | 140 | 0.090 | 2110ms | textRank 0.86 · clusterRank 0.10 · tfidf 0.02 · priority 0.01 · keyword 0.01 |
| rstext | domain | 1499 | 1497 | 2 | 6776 | 2371 | 0.696 | 1.674 | 140 | 0.107 | 3803ms | textRank 0.71 · clusterRank 0.27 · priority 0.01 · keyword 0.01 |
| rstext+embed | domain | 24 | 24 | 0 | 187 | 85 | 0.340 | 0.747 | 15 | 0.000 | 1629ms | textRank 0.66 · clusterRank 0.19 · priority 0.09 · keyword 0.05 |
| hybrid+embed+classify | visitTime | 24 | 24 | 0 | 185 | 87 | 0.260 | 0.576 | 15 | 0.000 | 1951ms | textRank 0.66 · clusterRank 0.14 · priority 0.09 · tfidf 0.06 · keyword 0.05 |

## hyperparameters around the rstext preset, 1499 live rows

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rstext anchor | domain | 1499 | 1497 | 2 | 6776 | 2371 | 0.696 | 1.674 | 140 | 0.000 | 2948ms | textRank 0.71 · clusterRank 0.27 · priority 0.01 · keyword 0.01 |
| topK 4 | domain | 1499 | 1497 | 2 | 5616 | 1796 | 0.720 | 1.674 | 140 | 0.757 | 6589ms | textRank 0.68 · clusterRank 0.29 · priority 0.02 · keyword 0.01 |
| topK 16 | domain | 1499 | 1497 | 2 | 13207 | 5938 | 0.611 | 1.674 | 140 | 0.399 | 2300ms | textRank 0.80 · clusterRank 0.18 · priority 0.01 · keyword 0.00 |
| minScore 0.02 | domain | 1499 | 1497 | 2 | 7027 | 2505 | 0.683 | 1.674 | 140 | 0.947 | 1486ms | textRank 0.72 · clusterRank 0.26 · priority 0.01 · keyword 0.01 |
| minScore 0.2 | domain | 1499 | 1497 | 2 | 7023 | 2505 | 0.683 | 1.674 | 140 | 0.947 | 1240ms | textRank 0.72 · clusterRank 0.26 · priority 0.01 · keyword 0.01 |
| minScore 0.7 | domain | 1499 | 1250 | 249 | 2888 | 363 | 0.849 | 1.674 | 140 | 0.153 | 888ms | textRank 0.56 · clusterRank 0.40 · priority 0.03 · keyword 0.01 |
| window 2 | domain | 1499 | 1497 | 2 | 6760 | 2435 | 0.692 | 1.671 | 139 | 0.929 | 613ms | textRank 0.72 · clusterRank 0.26 · priority 0.01 · keyword 0.01 |
| window 8 | domain | 1499 | 1497 | 2 | 6786 | 2349 | 0.694 | 1.619 | 139 | 0.938 | 2490ms | textRank 0.71 · clusterRank 0.26 · priority 0.01 · keyword 0.01 |
| rank window 2 | domain | 1499 | 1497 | 2 | 6657 | 2246 | 0.694 | 1.654 | 138 | 0.457 | 935ms | textRank 0.71 · clusterRank 0.27 · priority 0.01 · keyword 0.01 |
| rank window 8 | domain | 1499 | 1497 | 2 | 6723 | 2376 | 0.712 | 1.700 | 138 | 0.529 | 1884ms | textRank 0.71 · clusterRank 0.27 · priority 0.01 · keyword 0.01 |
| damping 0.5 | domain | 1499 | 1497 | 2 | 6933 | 2284 | 0.729 | 1.685 | 132 | 0.837 | 1080ms | textRank 0.71 · clusterRank 0.27 · priority 0.01 · keyword 0.01 |
| damping 0.95 | domain | 1499 | 1497 | 2 | 6744 | 2446 | 0.690 | 1.689 | 140 | 0.928 | 1221ms | textRank 0.72 · clusterRank 0.26 · priority 0.01 · keyword 0.01 |
| no clusterRank | domain | 1499 | 1497 | 2 | 6392 | 3357 | 0.562 | 1.350 | 149 | 0.677 | 432ms | textRank 0.97 · priority 0.02 · keyword 0.01 |
| no turboText | domain | 1499 | 1497 | 2 | 6759 | 2391 | 0.689 | 1.000 | 17 | 0.984 | 943ms | textRank 0.73 · clusterRank 0.27 |
| tfidf back on | domain | 1499 | 1497 | 2 | 6885 | 2478 | 0.746 | 1.804 | 130 | 0.943 | 1004ms | textRank 0.66 · clusterRank 0.24 · tfidf 0.07 · priority 0.01 · keyword 0.01 |
| burstGap 60s | domain | 1499 | 1497 | 2 | 6776 | 2371 | 0.696 | 1.674 | 140 | 1.000 | 986ms | textRank 0.71 · clusterRank 0.27 · priority 0.01 · keyword 0.01 |

## aim pass over 1499 live rows · priority from pin cards (1) (13 tags)

| case | aimMin | promote | rows | untagged | prio | focus/row | tags/row | sub rows | sub tags | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off | 0.40 | 3 | 1499 | 2 | 132 | 4.40 | 4.40 | 0 | 0 | 0ms |
| aimMin 0.2 | 0.20 | 3 | 1499 | 2 | 132 | 4.40 | 4.59 | 186 | 33 | 7ms |
| aimMin 0.4 | 0.40 | 3 | 1499 | 2 | 132 | 4.40 | 4.59 | 186 | 33 | 7ms |
| aimMin 0.7 | 0.70 | 3 | 1499 | 352 | 132 | 1.15 | 1.97 | 552 | 40 | 4ms |
| promoteMin 2 | 0.40 | 2 | 1499 | 2 | 132 | 4.40 | 4.88 | 407 | 124 | 9ms |
| promoteMin 3 | 0.40 | 3 | 1499 | 2 | 132 | 4.40 | 4.59 | 186 | 33 | 5ms |
| promoteMin 4 | 0.40 | 4 | 1499 | 2 | 132 | 4.40 | 4.49 | 84 | 11 | 3ms |

## rrf stages over the newest 600 of 1499 live rows · priority from pin cards (1) (13 tags)

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| preset | anchor | 600 | 599 | 1 | 2266 | 1064 | 1.915 | 34.000 | 119 | 25 | 1.000 | 445ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · md 22 |
| urls on | bm25f | 600 | 600 | 0 | 3032 | 1071 | 2.093 | 31.000 | 199 | 35 | 0.528 | 970ms | bm25,clusterRank,group,priority,textRank | google 175 · opera 171 · gemini 103 · youtube 102 · gx 87 · utf 73 |
| k1 0.5 | bm25f | 600 | 599 | 1 | 2279 | 1073 | 1.012 | 11.000 | 125 | 27 | 0.929 | 512ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · gemini 24 |
| k1 3 | bm25f | 600 | 599 | 1 | 2280 | 1063 | 1.014 | 11.000 | 125 | 27 | 0.935 | 922ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · gemini 24 |
| b 0 | bm25f | 600 | 599 | 1 | 2279 | 1073 | 1.012 | 11.000 | 125 | 27 | 0.927 | 438ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · gemini 24 |
| b 1 | bm25f | 600 | 599 | 1 | 2280 | 1068 | 1.012 | 11.000 | 125 | 27 | 0.958 | 568ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · gemini 24 |
| title only | bm25f | 600 | 582 | 18 | 2126 | 1046 | 0.721 | 11.000 | 59 | 17 | 0.957 | 570ms | bm25,clusterRank,group,priority,textRank | youtube 36 · 个人 27 · ai 26 · seer 23 · 博正 22 · gemini 17 |
| tags only | bm25f | 600 | 554 | 46 | 1086 | 30 | 152.798 | 212.000 | 521 | 14 | 0.014 | 359ms | bm25,clusterRank,group,priority,textRank | fixed 443 · dup 436 · Agent_Incentives 44 · fixmechange 37 · ctxSeer 17 · merged 15 |
| url field back | bm25f | 600 | 599 | 1 | 2280 | 1069 | 1.012 | 11.000 | 125 | 27 | 0.959 | 474ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · gemini 24 |
| k 1 | fusion | 600 | 584 | 16 | 977 | 339 | 3.883 | 35.000 | 159 | 16 | 0.308 | 385ms | bm25,clusterRank,group,priority,textRank | youtube 108 · chatgpt 73 · system 73 · seer 34 · 博正 31 · md 22 |
| k 10 | fusion | 600 | 598 | 2 | 1984 | 918 | 2.047 | 34.000 | 115 | 22 | 0.813 | 378ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · ai 23 · md 22 · fixmechange 19 |
| k 200 | fusion | 600 | 599 | 1 | 2257 | 1055 | 1.923 | 34.000 | 118 | 24 | 0.942 | 494ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · ai 28 · md 22 · 个人 18 |
| maxDf 1 (floor off) | global | 600 | 599 | 1 | 2266 | 1064 | 1.915 | 34.000 | 119 | 25 | 1.000 | 355ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · md 22 |
| maxDf 0.2 | global | 600 | 581 | 19 | 2123 | 1053 | 0.716 | 11.000 | 59 | 17 | 0.990 | 394ms | bm25,clusterRank,group,priority,textRank | youtube 36 · 个人 27 · ai 26 · seer 23 · 博正 22 · gemini 17 |
| stop off | global | 600 | 599 | 1 | 2270 | 1056 | 1.895 | 34.000 | 111 | 22 | 0.961 | 407ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · vs 25 |
| stop + maxDf 1 | global | 600 | 599 | 1 | 2270 | 1056 | 1.895 | 34.000 | 111 | 22 | 0.961 | 461ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · vs 25 |
| no bm25 | signals | 600 | 543 | 57 | 1285 | 269 | 2.284 | 11.000 | 294 | 15 | 0.218 | 396ms | clusterRank,group,priority,textRank | innovation 239 · us 239 · Agent_Incentives 46 · ctxSeer 43 · youtube 35 · ai 31 |
| no priority | signals | 600 | 589 | 11 | 2753 | 1075 | 1.786 | 34.000 | 108 | 26 | 0.981 | 1035ms | bm25,clusterRank,group,textRank | dup 155 · fixed 136 · youtube 108 · merged 94 · fixmechange 90 · seer 34 |
| no graph | signals | 600 | 590 | 10 | 2790 | 1092 | 1.909 | 34.000 | 119 | 22 | 0.729 | 340ms | bm25,group,priority | dup 210 · fixed 145 · merged 107 · youtube 106 · fixmechange 100 · ctxSeer 43 |
| no buckets | buckets | 600 | 590 | 10 | 2560 | 1048 | 0.506 | 0.983 | 0 | 0 | 0.972 | 887ms | bm25,clusterRank,priority,textRank | dup 147 · fixed 130 · merged 94 · fixmechange 90 · youtube 36 · ai 27 |
| mmr λ 0 | buckets | 600 | 599 | 1 | 2266 | 1063 | 1.943 | 35.000 | 119 | 25 | 0.995 | 480ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · md 22 |
| mmr λ 1 | buckets | 600 | 599 | 1 | 2266 | 1064 | 1.915 | 34.000 | 119 | 25 | 1.000 | 619ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · md 22 |
| graph λ 0 | buckets | 600 | 599 | 1 | 2266 | 1064 | 1.910 | 34.000 | 119 | 25 | 0.998 | 1187ms | bm25,clusterRank,group,priority,textRank | youtube 108 · seer 34 · 博正 31 · 个人 27 · ai 26 · md 22 |
| promote ≥ 2 | buckets | 600 | 599 | 1 | 2584 | 1191 | 1.896 | 34.000 | 293 | 153 | 0.890 | 526ms | bm25,clusterRank,group,priority,textRank | youtube 108 · ai 49 · 博正 35 · seer 34 · 个人 27 · risk 25 |
| promote ≥ 5 | buckets | 600 | 599 | 1 | 2165 | 1045 | 1.835 | 34.000 | 70 | 6 | 0.982 | 381ms | bm25,clusterRank,group,priority,textRank | youtube 108 · ai 26 · seer 23 · 博正 19 · fixmechange 17 · rejected 17 |
| themes ≤ 1 | buckets | 600 | 599 | 1 | 2161 | 1053 | 1.307 | 34.000 | 119 | 14 | 0.990 | 463ms | bm25,clusterRank,group,priority,textRank | youtube 72 · ai 26 · seer 23 · 博正 22 · 个人 19 · gemini 17 |

## qarf alpha over the newest 600 of 1499 live rows · priority from pin cards (1) (13 tags)

| case | rows | empty | sugg | dist | λ̄ | σλ | λ clip | sub rows | sub tags | jaccard | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| α 0 (= rrf) | 600 | 1 | 2266 | 1064 | 0.667 | 0.000 | 0.00 | 119 | 25 | 1.000 | 577 |
| α 0.5 | 600 | 1 | 2189 | 1042 | 0.569 | 0.145 | 0.00 | 81 | 21 | 0.902 | 1051 |
| α 1 (default) | 600 | 1 | 2208 | 1037 | 0.502 | 0.216 | 0.10 | 82 | 20 | 0.858 | 789 |
| α 2 | 600 | 1 | 2212 | 1030 | 0.430 | 0.280 | 0.26 | 81 | 19 | 0.813 | 1049 |
| α 4 | 600 | 1 | 2223 | 1023 | 0.386 | 0.312 | 0.58 | 94 | 20 | 0.791 | 760 |
| α 1, clip 0.2/0.8 | 600 | 1 | 2289 | 1041 | 0.511 | 0.193 | 0.20 | 118 | 23 | 0.861 | 879 |
| α 1, clip 0.01/0.99 | 600 | 1 | 2205 | 1037 | 0.497 | 0.227 | 0.00 | 82 | 20 | 0.858 | 534 |
| α 1, floor 0.3 | 600 | 1 | 2296 | 1043 | 0.529 | 0.174 | 0.20 | 118 | 24 | 0.865 | 464 |
| α 1, ceil 0.7 | 600 | 1 | 2182 | 1035 | 0.490 | 0.201 | 0.23 | 82 | 20 | 0.869 | 461 |
| α 0.5, clip 0.2/0.8 | 600 | 1 | 2261 | 1044 | 0.569 | 0.143 | 0.02 | 117 | 23 | 0.906 | 442 |
| α 1, no burst | 600 | 1 | 2208 | 1037 | 0.502 | 0.216 | 0.10 | 82 | 20 | 0.858 | 452 |

## rrf over the 404 live rows carrying suffix_GoogleSearch · the pattern every row of the list repeats

| case | stage | rows | scored | empty | sugg | dist | mean | max | sub rows | sub tags | jaccard | ms | channels | roots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| urls on, w url 1 | filtered | 404 | 404 | 0 | 2426 | 718 | 8.811 | 87.000 | 208 | 15 | 1.000 | 759ms | bm25,clusterRank,group,priority,textRank | gx 397 · opera 357 · google 266 · utf 230 · gws 130 · serp 56 |
| urls off, w url 1 | filtered | 404 | 401 | 3 | 1681 | 1276 | 0.553 | 5.000 | 8 | 3 | 0.434 | 241ms | bm25,clusterRank,group,priority,textRank | database 15 · ai 7 · risk 7 · convexity 6 · similar 6 · com 5 |
| urls off, w url 0 | filtered | 404 | 401 | 3 | 1681 | 1277 | 0.553 | 5.000 | 8 | 3 | 0.430 | 217ms | bm25,clusterRank,group,priority,textRank | ideas 15 · ai 7 · risk 7 · convexity 6 · similar 6 · biggest 5 |
| urls off, w url 0, floor on | filtered | 404 | 401 | 3 | 1681 | 1277 | 0.553 | 5.000 | 8 | 3 | 0.430 | 159ms | bm25,clusterRank,group,priority,textRank | ideas 15 · ai 7 · risk 7 · convexity 6 · similar 6 · biggest 5 |
| urls off, w url 0, floor on, f= named | filtered | 404 | 401 | 3 | 1677 | 1275 | 0.553 | 5.000 | 8 | 3 | 0.430 | 243ms | bm25,clusterRank,group,priority,textRank | ideas 15 · ai 7 · index 7 · risk 7 · convexity 6 · similar 6 |

## dynamic channels against a local provider, 24 live rows

| case | dim | rows | scored | empty | sugg | dist | mean | max | prio | jaccard | ms | channels |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rstext+embed | domain | 24 | 24 | 0 | 187 | 104 | 0.663 | 1.169 | 9 | 0.000 | 716ms | embed 0.51 · textRank 0.35 · clusterRank 0.09 · priority 0.03 · keyword 0.01 |
| hybrid+embed+classify | visitTime | 24 | 24 | 0 | 188 | 105 | 0.452 | 0.827 | 9 | 0.000 | 426ms | embed 0.45 · textRank 0.39 · clusterRank 0.07 · tfidf 0.04 · priority 0.03 · keyword 0.02 · suggest 0.00 |

## aim pass

![aim pass](srctag-sweep.svg)
