# Rotation Model (After 10 Games, updated postgame G10)

## Starting Lineup History
G1-G2: Brown, White, Queta, Pritchard, Hauser
G3: Brown, White, Queta, Pritchard, González
G4-G10: Brown, White, Queta, Pritchard, Minott → **7 straight starts**

→ Brown/White/Queta/Pritchard LOCKED starters (10/10)
→ 5th spot: Minott ESTABLISHED (7 straight starts)

## Minutes Distribution (10 games)
| Player | G1 | G2 | G3 | G4† | G5B | G6 | G7† | G8 | G9B | G10 | NonB2B Avg |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Brown | *36 | *35 | *35 | *24 | *32 | *32 | *22 | *37.6 | *25.9 | *36.5 | 33.7 |
| White | *35 | *33 | *37 | *31 | *35 | *35 | *19 | *32.6 | *28.8 | *37.1 | 34.2 |
| Pritchard | *37 | *36 | *34 | *31 | *32 | *33 | *26 | *34.5 | *23.9 | *31.9 | 33.0 |
| Simons | 32 | 27 | 23 | 32 | 26 | 29 | 17 | 26.3 | 29.8 | 17.6 | 26.4 |
| Hauser | *22 | *28 | 24 | 26 | 21 | 24 | 17 | 28 | 22.3 | 20.5 | 23.6 |
| Queta | *25 | *22 | *26 | *22 | *26 | *19 | *15 | *26.2 | *24.2 | *30.0 | 24.8 |
| Minott | 14 | DNP | 14 | *28 | *33 | *22 | *19 | *15 | *33.7 | *25.3 | 22.3 |
| Garza | 6 | DNP | 13 | 19 | 16 | 15 | 15 | 10.9 | 7.1 | 13.4 | 12.6 |
| González | DNP | 23 | 18 | DNP | 4 | 15 | 17 | 8 | 16.6 | 8.8 | 13.1 |
| Scheierman | DNP | 4 | 5 | 14 | 10 | 3 | 23 | 7.2 | 3.7 | DNP | 4.8 |
| Tillman | 16 | 14 | DNP | 6 | 4 | 13 | 2 | 6.4 | DNP | OUT | 10.7 |
| Boucher | 16 | 15 | 9 | 3 | DNP | DNP | 13 | 7.3 | DNP | DNP | 10.7→declining |
| Walsh | DNP | 2 | DNP | 1 | 1 | DNP | 19 | DNP | 23.9 | 18.8 | 7.7 |

†B2B games. B = Blowout win. *=started

## Game Type Results & Walsh/Bench Patterns (Updated G10)
| Game | Type | Margin | Walsh | Boucher | Simons | Minott |
|---|---|---|---|---|---|---|
| G1 | Close L | -1 | DNP | 16 | 32 | 14 |
| G2 | Moderate L | -10 | 2 | 15 | 27 | DNP |
| G3 | Close L | -6 | DNP | 9 | 23 | 14 |
| G4 | B2B Blowout W | +32 | 1 | 3 | 32 | *28 |
| G5 | Blowout W | +20 | 1 | DNP | 26 | *33 |
| G6 | Close W | +1 | DNP | DNP | 29 | *22 |
| G7 | B2B Blowout L | -27 | 19 | 13 | 17 | *19 |
| G8 | Close L | -2 | DNP | 7.3 | 26.3 | *15 |
| G9 | Blowout W | +29 | 23.9 | DNP | 29.8 | *33.7 |
| G10 | Moderate L | -13 | 18.8 | DNP | 17.6 | *25.3 |

## Walsh Playing Pattern (REVISED - Critical)
- **Close games (margin ≤6)**: G1 DNP, G3 DNP, G6 DNP, G8 DNP → **DNP 100%** (4/4)
- **Moderate loss (margin 7-13)**: G2 2min, G10 18.8min → **Plays ~60%**, minutes vary
- **Blowout (margin 20+)**: G5 1min, G7 19min, G9 23.9min → **Plays ~80%**, high minutes
- **B2B**: G4 1min, G7 19min → varies with margin
- **NEW INSIGHT**: Walsh enters when BOS trails 10+ at any point in game, even if game is competitive overall. In G10, entered at 4.6 min left in Q1 when BOS was down ~13. Played 7.4 min of Q2. This is an energy/defense sub, not just garbage time.
- **When Walsh plays significant minutes (19+), Simons loses minutes** - Walsh took Simons' Q2 slot in G10

→ p_play: close games 0.15, underdog/moderate games 0.50, blowout expected 0.80

## Boucher Trend (DECLINING)
- Last 5 games: G6 DNP, G7 13min, G8 7.3min, G9 DNP, G10 DNP
- DNP even with Tillman OUT in G10 → truly falling out of rotation
- p_play going forward: ~0.45-0.50 (was 0.67 overall, but recent trend is much lower)
- When he plays: 3-16 min, avg ~10

## Simons Minutes Variability
- Non-B2B range: 17.6-32 (much wider than I assumed)
- When Walsh gets 19+ min: Simons drops to 17-18 min
- Normal games: 23-32 min, median ~27
- Adjusted range: wider, p50 ~25, with 15-17 as the low end

## Close Game Minutes Model (G1,G2,G3,G6,G8,G10 - non-blowout non-B2B)
| Player | Avg | Range | Notes |
|---|---|---|---|
| Brown | 35.2 | 32-37.6 | Heavy in competitive games |
| White | 34.9 | 32.6-37.1 | Consistent |
| Pritchard | 34.1 | 31.9-37 | Consistent |
| Simons | 25.8 | 17.6-32 | WIDER range than expected! |
| Hauser | 24.2 | 20.5-28 | Reliable |
| Queta | 24.7 | 19-30 | Increased recently |
| Minott | 18.1 | 14-25.3 | Higher when trailing |
| Garza | 11.7 | 6-15 | Consistent |
| González | 12.7 | 4-23 | Very volatile |
| Walsh | 3.5 | 0-18.8 | 0 in close, 19 when trailing |

## Minott Pattern (Updated G10)
- Starts every game since G4 (7 straight)
- Close games (≤6pt margin): 14, 14, 22, 15 = avg 16.2
- Moderate loss (G10, -13pt): 25.3 → higher when trailing
- Blowout wins: 33, 33.7 = avg 33.4
- B2B: 28, 19 = avg 23.5
- **Revised model**: Close games 15-22, trailing games 22-28, blowouts 30-34

## FP/min Rates (10 games)
| Player | FP/min | Notes |
|---|---|---|
| Brown | 1.31 | Elite |
| Queta | 1.00 | Double-double upside |
| Pritchard | 1.00 | Consistent |
| White | 0.96 | Defensive FP |
| Minott | 0.90 | Developing |
| Simons | 0.78 | Volume scorer off bench |
| Hauser | 0.72 | Shooting-dependent |
| Walsh | 0.73 | Decent when he plays |
