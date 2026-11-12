# Forecast evaluation

- full-memory, r1 · flagged games 0022500146 · excluded games none
- no-memory, r1 · flagged games none · excluded games none

## Including flagged games (10 games)

### full-memory vs reference · r1

Analyst spend $ 39.6821 and 12711.177 seconds. Reference spend is unmetered.

| Score | Analyst | Reference | Difference (90% interval) |
|---|---:|---:|---:|
| minutes.pinball | 1.2086 | 1.5558 | -0.3472 [-0.6306, -0.1142] |
| points.pinball | 1.2652 | 1.3929 | -0.1277 [-0.1731, -0.0821] |
| rebounds.pinball | 0.5866 | 0.5776 | 0.009 [-0.0273, 0.045] |
| assists.pinball | 0.3089 | 0.3263 | -0.0174 [-0.0408, 0.0072] |
| fantasy_points.pinball | 2.0442 | 2.2189 | -0.1747 [-0.2604, -0.0827] |
| playBrier | 0.1361 | 0.1298 | 0.0063 [-0.038, 0.0419] |
| market.brier | 0.2522 | 0.2665 | -0.0143 [-0.0286, 0.0003] |
| market.consensusBrier | 0.2456 | 0.2456 | 0 [0, 0] |
| market.blendMinusMarketOnly | 0.0059 | -0.0012 | 0.007 [-0.0016, 0.0177] |
| Held-out blend change, 90% interval | -0.0018 to 0.0148 | -0.0058 to 0.0038 | |
| big.baseRate | 0.1651 | 0.1651 | 0 [0, 0] |
| big.hitRate | 0.2667 (8/30) | 0.3667 (11/30) | -0.1 [-0.1667, -0.0333] |
| big.voidRate | 0 (0/30) | 0 (0/30) | 0 [0, 0] |
| big.hitRateWithoutVoids | 0.2667 | 0.3667 | -0.1 [-0.1667, -0.0333] |
| big.brier | 0.1447 | 0.1435 | 0.0012 [-0.0071, 0.0091] |
| ceiling.hitRate | 0.1 (3/30) | 0.0897 (9.7479/108.7157) | 0.0103 [-0.0366, 0.06] |
| ceiling.brier | 0.0901 | 0.093 | -0.0029 [-0.0093, 0.0031] |
| ceiling.voidRate | 0.0667 (2/30) | — (0/0) | — [—, —] |

### no-memory vs reference · r1

Analyst spend $ 20.6074 and 7197.162 seconds. Reference spend is unmetered.

| Score | Analyst | Reference | Difference (90% interval) |
|---|---:|---:|---:|
| minutes.pinball | 1.271 | 1.5558 | -0.2847 [-0.5784, -0.0036] |
| points.pinball | 1.3118 | 1.3929 | -0.0811 [-0.1677, 0.0176] |
| rebounds.pinball | 0.5619 | 0.5776 | -0.0157 [-0.0499, 0.0204] |
| assists.pinball | 0.2928 | 0.3263 | -0.0336 [-0.0538, -0.0131] |
| fantasy_points.pinball | 2.1006 | 2.2189 | -0.1182 [-0.269, 0.0708] |
| playBrier | 0.139 | 0.1298 | 0.0092 [-0.0343, 0.0442] |
| market.brier | 0.2431 | 0.2665 | -0.0234 [-0.0343, -0.0126] |
| market.consensusBrier | 0.2456 | 0.2456 | 0 [0, 0] |
| market.blendMinusMarketOnly | 0.0006 | -0.0012 | 0.0018 [-0.0073, 0.0112] |
| Held-out blend change, 90% interval | -0.0075 to 0.0088 | -0.0058 to 0.0038 | |
| big.baseRate | 0.1651 | 0.1651 | 0 [0, 0] |
| big.hitRate | 0.3 (9/30) | 0.3667 (11/30) | -0.0667 [-0.2, 0.0667] |
| big.voidRate | 0 (0/30) | 0 (0/30) | 0 [0, 0] |
| big.hitRateWithoutVoids | 0.3 | 0.3667 | -0.0667 [-0.2, 0.0667] |
| big.brier | 0.136 | 0.1435 | -0.0075 [-0.0138, -0.0016] |
| ceiling.hitRate | 0.1667 (5/30) | 0.0897 (9.7479/108.7157) | 0.077 [0.0115, 0.1453] |
| ceiling.brier | 0.0888 | 0.093 | -0.0042 [-0.0091, 0.0012] |
| ceiling.voidRate | 0.0333 (1/30) | — (0/0) | — [—, —] |

### Full memory minus no memory

| Score | Difference | 90% interval | After omitting five influential games |
|---|---:|---:|---:|
| minutes.pinball | -0.0625 | -0.2271 to 0.0791 | -0.0433 |
| points.pinball | -0.0466 | -0.1141 to 0.0139 | -0.0447 |
| rebounds.pinball | 0.0247 | -0.0142 to 0.0606 | 0.0239 |
| assists.pinball | 0.0162 | 0.0045 to 0.0277 | 0.0226 |
| fantasy_points.pinball | -0.0565 | -0.2055 to 0.0669 | -0.0349 |
| playBrier | -0.0029 | -0.0255 to 0.019 | 0.0008 |
| ceiling.hitRate | -0.0667 | -0.1333 to 0 | 0 |
| big.hitRate | -0.0333 | -0.1333 to 0.0667 | 0 |
| market.blendMinusMarketOnly | 0.0053 | 0.0011 to 0.0097 | 0.0056 |

r1 spend difference $ 19.0747, time difference 5514.015 seconds.

## Excluding flagged games (9 games)

### full-memory vs reference · r1

Analyst spend $ 36.8556 and 11741.103 seconds. Reference spend is unmetered.

| Score | Analyst | Reference | Difference (90% interval) |
|---|---:|---:|---:|
| minutes.pinball | 1.1061 | 1.4919 | -0.3858 [-0.6952, -0.1309] |
| points.pinball | 1.2177 | 1.3596 | -0.1419 [-0.1841, -0.0986] |
| rebounds.pinball | 0.5958 | 0.5857 | 0.01 [-0.0301, 0.0496] |
| assists.pinball | 0.3059 | 0.3253 | -0.0193 [-0.0452, 0.0088] |
| fantasy_points.pinball | 1.9545 | 2.1486 | -0.1941 [-0.2795, -0.0989] |
| playBrier | 0.1384 | 0.1315 | 0.0069 [-0.0421, 0.0474] |
| market.brier | 0.25 | 0.2657 | -0.0158 [-0.0316, 0.0003] |
| market.consensusBrier | 0.2459 | 0.2459 | 0 [0, 0] |
| market.blendMinusMarketOnly | 0.0053 | -0.0002 | 0.0055 [-0.0056, 0.0191] |
| Held-out blend change, 90% interval | -0.0063 to 0.0184 | -0.0039 to 0.0039 | |
| big.baseRate | 0.1771 | 0.1771 | 0 [0, 0] |
| big.hitRate | 0.2593 (7/27) | 0.3704 (10/27) | -0.1111 [-0.1852, -0.037] |
| big.voidRate | 0 (0/27) | 0 (0/27) | 0 [0, 0] |
| big.hitRateWithoutVoids | 0.2593 | 0.3704 | -0.1111 [-0.1852, -0.037] |
| big.brier | 0.1522 | 0.1509 | 0.0013 [-0.0077, 0.0099] |
| ceiling.hitRate | 0.1111 (3/27) | 0.0872 (8.4747/97.1327) | 0.0239 [-0.0219, 0.0746] |
| ceiling.brier | 0.087 | 0.0903 | -0.0033 [-0.0105, 0.0035] |
| ceiling.voidRate | 0.0741 (2/27) | — (0/0) | — [—, —] |

### no-memory vs reference · r1

Analyst spend $ 19.1111 and 6660.579 seconds. Reference spend is unmetered.

| Score | Analyst | Reference | Difference (90% interval) |
|---|---:|---:|---:|
| minutes.pinball | 1.0902 | 1.4919 | -0.4017 [-0.6673, -0.1909] |
| points.pinball | 1.2316 | 1.3596 | -0.128 [-0.1895, -0.0641] |
| rebounds.pinball | 0.5539 | 0.5857 | -0.0319 [-0.0599, -0.0063] |
| assists.pinball | 0.2884 | 0.3253 | -0.0368 [-0.0583, -0.0145] |
| fantasy_points.pinball | 1.9339 | 2.1486 | -0.2147 [-0.3036, -0.1319] |
| playBrier | 0.1316 | 0.1315 | 0.0001 [-0.0445, 0.0362] |
| market.brier | 0.2426 | 0.2657 | -0.0232 [-0.0353, -0.011] |
| market.consensusBrier | 0.2459 | 0.2459 | 0 [0, 0] |
| market.blendMinusMarketOnly | -0.0003 | -0.0002 | -0.0001 [-0.0112, 0.0113] |
| Held-out blend change, 90% interval | -0.0112 to 0.0111 | -0.0039 to 0.0039 | |
| big.baseRate | 0.1771 | 0.1771 | 0 [0, 0] |
| big.hitRate | 0.2963 (8/27) | 0.3704 (10/27) | -0.0741 [-0.2222, 0.0741] |
| big.voidRate | 0 (0/27) | 0 (0/27) | 0 [0, 0] |
| big.hitRateWithoutVoids | 0.2963 | 0.3704 | -0.0741 [-0.2222, 0.0741] |
| big.brier | 0.1437 | 0.1509 | -0.0072 [-0.0142, -0.0007] |
| ceiling.hitRate | 0.1852 (5/27) | 0.0872 (8.4747/97.1327) | 0.0979 [0.034, 0.1628] |
| ceiling.brier | 0.0833 | 0.0903 | -0.007 [-0.0104, -0.0039] |
| ceiling.voidRate | 0.037 (1/27) | — (0/0) | — [—, —] |

### Full memory minus no memory

| Score | Difference | 90% interval | After omitting five influential games |
|---|---:|---:|---:|
| minutes.pinball | 0.0159 | -0.0802 to 0.113 | 0.0413 |
| points.pinball | -0.014 | -0.0584 to 0.0307 | -0.0292 |
| rebounds.pinball | 0.0419 | 0.0144 to 0.0698 | 0.0294 |
| assists.pinball | 0.0175 | 0.0047 to 0.0297 | 0.0271 |
| fantasy_points.pinball | 0.0206 | -0.0523 to 0.0941 | -0.0088 |
| playBrier | 0.0069 | -0.0097 to 0.0255 | 0.0036 |
| ceiling.hitRate | -0.0741 | -0.1481 to 0 | 0 |
| big.hitRate | -0.037 | -0.1481 to 0.0741 | 0 |
| market.blendMinusMarketOnly | 0.0056 | -0.0001 to 0.0116 | 0.01 |

r1 spend difference $ 17.7445, time difference 5080.524 seconds.

The JSON report includes tier splits, game-by-game learning curves, replicate spread, influence and score denominators.
