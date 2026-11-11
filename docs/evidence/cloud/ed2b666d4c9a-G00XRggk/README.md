# SPO-877 Graviton acceptance

The run used clean commit `ed2b666d4c9a9cdb575afcc21577445f7880cb67` on
Ubuntu 24.04 arm64, AMI `ami-09a93d801db0bafae`, in us-east-1. The
[manifest](manifest.json) records 16 Docker CPUs and 33,012,969,472 bytes of
memory on an on-demand c8g.4xlarge. The encrypted 200 GiB gp3 root volume had
198,932,221,952 bytes available after acceptance. The cold R2 object cache
grew to 189,781,280 bytes. The run used offline scoring and scripted model
providers. The bootstrap log recorded Ubuntu package versions
`docker.io 29.1.3-0ubuntu3~24.04.2`, `containerd 2.2.1-0ubuntu1~24.04.4`
and `runc 1.3.4-0ubuntu1~24.04.1`.

Type checking and formatting passed. The standard suite passed 318 tests
with 16 optional skips. All 22 tests in the assembler, starter and backtest
command and all 15 research-sandbox tests passed. The scripted launcher
completed both games. [Acceptance log](acceptance.log)

The [opener fit](opener.json) took 45.77 seconds. All ten
[development fits](development.json) reproduced the SPO-873 model hashes.
The 584 scored windows reproduced timing Brier 0.16486313135424627 and set
log loss 4.323299538360917 exactly.

## Backtest timing at game 0022501206

Each process loaded 104 games with 5,397 eligible windows. Cold and cached
refer to the in-process history cache. The repeat started a new process with
the previously downloaded R2 objects available on disk.

| Audit | History load (s) | Cold windows | Cold elapsed (s) | Cached windows | Cached elapsed (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Package](backtest.json) | 120.77 | 0 | 121.06 | 5,397 | 12.26 |
| [Starter](starter-backtest.json) | 119.62 | 0 | 120.11 | 3,072 | 120.30 |
| [Package repeat](backtest-repeat.json) | 120.15 | 0 | 120.49 | 5,397 | 12.52 |

Both standalone audit scripts exited 1. Each cold call reached the 120-second
compute limit before completing a batch. The cached starter call also reached
the limit. It scored 3,072 windows with zero invalid outputs and zero starter
errors. This audit uses the directly evaluated starter comparison. The
SPO-876 performance audit with precomputed starter predictions is a separate
workload.

The first package audit stopped the original acceptance script. The starter
audit and package repeat ran separately from the same clean checkout without
changing the time limit. [Follow-up log](backtest-followup.log)

AWS confirmed the instance was stopped after the evidence and scripted run root
were retrieved. The encrypted root volume was retained for resume.

## Implications for machine selection

At the same cutoff, the Mac loaded package history in 80.8 s and completed
the cold call in 112.4 s. On c8g.4xlarge, even the repeat with R2 objects on
disk spent 120.15 s loading history. Once history was in memory, the cloud
package call took 12.26 s versus 31.53 s on the Mac. The standalone cached
starter call hit the limit on both machines (1,792 windows on the Mac and
3,072 on EC2). These timings include differences between code revisions and
do not isolate CPU decoding time. [Mac package](../../policy/backtest-spo872.json)
and [Mac starter](../../policy/backtest-spo873.json).

With elapsed-time charging, a cold v3 backtest on this instance can consume
its entire allowance loading history. Before confirming a scored machine,
compare initializing history before the charged call on c8g with an instance
that loads it faster. For v4, measure the research sandbox and the SPO-879
reference projection’s pregame refit on the intended scored machine before
setting the V5 budget. The v3 backtest provides no timing for that refit.
