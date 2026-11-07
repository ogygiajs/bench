# Odds it shows on the clock

Steps are exact. Time is not, and a step change does not always show on the clock. In the quick
start, a second loop added 58% to a case's steps and the time layer saw nothing: the case runs in
84 ns, on the timer's grain, and the engine made the loop nearly free. A planted case with 12%
more steps from more `JSON.stringify` calls timed 14% slower at both of its sizes.

So next to each changed case, the PR comment gives the odds that the change shows up on the
clock:

```md
| Case | Steps | Δ | Odds it shows on the clock |
| --- | ---: | ---: | ---: |
| rank: twenty rows | 897 → 1,417 | +520 (+58.0%) | 73% |
```

"73%" means: of changes like this one (this big, in a case this big, in this kind of work), about
73 in 100 made the time layer say slower or faster beyond noise. It is a bet, from a small model
fitted on timed changes. The steps next to it are still the fact. (This one is a bet the model
loses: the same pair is in the dataset, and it was "same" on both machines. See "Range" below.)

**Pass or fail never uses the odds.** The gate is the exact counts, as before. A step change at
5% odds is still listed, and one at 95% is not judged any harder.

## The odds come from one quiet runner

The changes the model learned from (dataset v2) were timed on a fresh GitHub-hosted runner where
nothing else ran: AMD EPYC, 4 cores, Linux, Node 26.13.0. The 1-minute load average was 1.3 to 6.8
(mean 2.9), most of it the bench's own counting just before each group was timed.

The first model (dataset v1) learned from a laptop that was busy the whole time (load 7 to 20 on
16 cores). A busy machine makes timings spread, and the time layer's noise rule is cautious, so
spread hid real changes: on the quiet runner, 23 of 36 changes of 3 to 10% showed, against 9 of
38 on the laptop, and 32 of 56 planted speedups against 19. Two real ogygia changes the laptop
called "same" though the samples showed them (a step cut in `transformHost`, a 155% step rise in
the federation wire code) are beyond noise on the runner; held out, the model gives them 83% and
81%. So the odds no longer lean low the way v1's did.

What is still true of them:

- They are about **this time layer's verdict**, not what a user feels in an app. A case that runs
  once per page load matters even if its 3% never clears the noise rule.
- They are from **one machine type and one Node**. Another CPU or V8 can make a different kind of
  work cheap, and a busier machine sees fewer changes.

[calibration/data/training.md](../calibration/data/training.md) has both datasets, side by side.
Retraining is one command, and the model file names the dataset it was fitted on.

## What goes in

A case whose steps did not change gets no odds. For one whose steps did, seven numbers from the
two reports' counts:

| Feature         | What                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `steps_moved`   | how far the case's steps moved, either way: abs(ln(PR / base))         |
| `steps_size`    | the size of the case: log10 of the smaller side's steps                |
| `steps_delta`   | how many steps moved: log10 of abs(PR − base)                          |
| `faster`        | 1 when the PR does fewer steps                                         |
| `builtin_share` | the share of the change in priced built-ins (`JSON.stringify`, `sort`) |
| `call_share`    | the share in calls (a call is priced 4 steps and costs less time)      |
| `alloc_share`   | the share in allocations (`{}`, `[]`, `new`)                           |

The shares come from the units each report keeps, priced with the current prices (dataset v2 was
counted with prices v3, the current ones; v1 with prices v2; the model file names them). A report
from before units were kept gets no odds.

Tried and left out, because the held-out scores got worse with them on dataset v1: how far
allocations, bytes and calls moved, the engine health findings (worse and better), a share for
string work, and the input size (which a report does not have). 186 changed pairs are few for
thirteen inputs. A bigger dataset can bring them back. The function's real-cost weight is not in
the dataset yet. On v2, three more were tried for small cases (a "fewer than 5,000 steps" flag,
the case size squared, steps moved times case size): none moved the mean held-out AUC or Brier
by more than 0.003, so the seven stay. The penalty was checked again too: 1 still has the lowest
Brier (0.151, against 0.151 at 0.3 and 0.154 at 3).

## The model

Logistic regression with an L2 penalty of 1, on the seven features standardized, fitted by
Newton's method (`src/models/logistic.ts`, no dependency). It is fitted on the 186 pairs of
dataset v2 whose steps changed; 92 of them were beyond noise.

**Dataset v2 alone, not v1 and v2 together.** Both were held out the same way, scoring the v2
pairs only, and with a change's v1 pairs left out of training whenever its v2 pairs are held out
(mean over fold seeds 1 to 20):

| Trained on                       | AUC on v2 | Brier on v2 |
| -------------------------------- | --------: | ----------: |
| v2 alone                         |     0.857 |       0.151 |
| v1 and v2                        |     0.858 |       0.158 |
| v1 alone (the old `feel.json`)\* |     0.863 |       0.167 |

\* Not held out: the same changes are in v1. Even so its odds run low on v2 (of the pairs it gave
20 to 40%, 67% showed).

The two rank changes alike; v1's labels, from the busy laptop, pull the odds down, so mixing them
in costs calibration (of the pairs v1 and v2 together gave 20 to 40%, 54% showed). And v2 is
counted with the prices a report is priced with today.

**Held out.** The pairs are split into 5 folds by group: a group is one ogygia commit, or one
planted change at all its sizes, so no change is on both sides of a split. Each fold is predicted
by a model fitted on the other four. The baseline is "every step change shows": odds 1 for every
changed pair.

| Pairs                  | Odds                    |   AUC | Brier |
| ---------------------- | ----------------------- | ----: | ----: |
| 186 with a step change | this model              | 0.831 | 0.165 |
| 186 with a step change | every step change shows | 0.500 | 0.505 |
| all 475                | this model              | 0.959 | 0.065 |
| all 475                | every step change shows | 0.877 | 0.198 |

On "all 475", the 289 pairs with no step change get 0 from both; none of them was beyond noise.
AUC is the chance a change that showed gets higher odds than one that did not (0.5 is a coin).
Brier is the mean squared gap between the odds and what happened (0 is perfect). Over fold seeds
1 to 20, AUC is 0.824 to 0.881 and Brier 0.137 to 0.170.

The v1 model scored 0.905 and 0.127 on v1. The drop is the labels, not the fit: on the quiet
runner many more changes of 3 to 10% show, and those are the hard ones to call either way. The
baseline gains more (Brier 0.591 to 0.505), because more of the changes showed.

**Reliability**: held-out odds against what the clock said.

| Odds        | Pairs | Mean odds | Showed on the clock | v1: pairs | v1: mean odds | v1: showed |
| ----------- | ----: | --------: | ------------------: | --------: | ------------: | ---------: |
| 0% to 20%   |    45 |        6% |                  7% |        80 |            8% |         6% |
| 20% to 40%  |    26 |       29% |                 27% |        24 |           29% |        33% |
| 40% to 60%  |    42 |       51% |                 60% |        33 |           50% |        64% |
| 60% to 80%  |    40 |       70% |                 73% |        15 |           72% |        73% |
| 80% to 100% |    33 |       89% |                 85% |        34 |           94% |        91% |

The features and the penalty were picked on these same folds (mean over seeds 1 to 20), so the
scores above are a little better than a fresh dataset would give.

**Range.** The dataset's cases run from about 700 to 22 million steps. Odds for a case far
outside that are a stretch of the fit, not something it saw. The fit is weakest at the two ends
of case size. Tiny cases: the quick start's extra loop (`answer-extra-loop-n20` and its undo, 897
steps) never showed on either machine, and the model gives it 72% and 82%; the engine makes that
loop nearly free, and nothing in the seven features says so.
Small changes of big cases: +1% of a million steps gets about 25%, though only 2 of the 57
changes under 3% showed. One slope in case size fits both ends less well than it fits the middle.

## Retraining

```bash
cd packages/heisenbench
node src/cli.ts feel train                    # dataset v2: writes feel.json, prints the tables above
node src/cli.ts feel train --data-version 1   # the busy laptop's dataset, for comparison
node src/cli.ts feel check                    # fits again: exit 1 unless the bytes are the same
```

`--seed` picks the folds of the held-out check (the fit itself uses every pair and no seed),
`--md file` writes the tables, `--data dir` reads the dataset from elsewhere. The same dataset and
seed give the same `feel.json`, byte for byte: Newton's method has no random start, and the file
keeps six significant digits. `feel.json` (about 2 KB) is committed and ships with the package; it
names its dataset version and the hash of both dataset files.
[calibration/data/training.md](../calibration/data/training.md) has the dataset and how to
regenerate it.
