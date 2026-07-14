# The detector image is built locally

## Discovery — "there is no Podman on the dev box" was false
*discovery · 2026-07-13*

Entry [11](11-container-detector.md) justified building the detector image with `az acr build`
(i.e. **inside Azure**) like this:

> **There is no Docker or Podman on the dev box**, and the project had already rejected
> Docker-inside-distrobox as too fragile to depend on. The only build engine available is the
> one in the cloud.

The first half is true and the conclusion does not follow. There is no podman **inside the
box** — but **this distrobox is itself run by the host's podman**. The engine was there the
whole time, one hop away; the box just could not see it. `distrobox-host-exec` reaches it:

```
distrobox (Ubuntu 24.04)  ──distrobox-host-exec──►  podman 5.8.4 on the host (Fedora)
  terraform, az, make                                  build + push
```

**The lesson worth keeping:** "the tool is not on my PATH" and "the tool is not on this
machine" are different statements, and the first one gets mistaken for the second. The
justification had been written down, reviewed, repeated in `infra/README.md` and drawn in
`docs/arquitectura.drawio` — a false premise, propagated by being quoted rather than rechecked.

## Decision — build with the host's podman, push to ACR
*decision · 2026-07-13*

`scripts/build-detector-image.sh` builds the image and pushes it;
`terraform_data.detector_image` (`infra/detector.tf`) calls it, so the dependency edge
`registry -> image -> container app` stays a real Terraform edge, exactly as before. The build
did **not** move out of the apply — that part of the v2 design was right.

**Podman runs on the HOST, never inside the box.** Rootless podman-inside-podman gets no
overlay-on-overlay and falls back to the `vfs` storage driver, which copies the entire
filesystem per layer — for a ~1 GB Spark image that is slow and enormous. Installing podman in
the box would be Docker-inside-distrobox again with a different binary.

**What it buys:**

- The image can be **run and smoke-tested before it ever reaches Azure** (`make detector-image`
  builds it with no push, no registry and no Azure session).
- It let us **verify the Dockerfile's central claim**, which until now was an article of faith:
  run with `--network none`, Ivy resolves the Kafka connector **from the baked cache**
  (`Ivy Default Cache set to: /opt/ivy/cache`, `resolve 266ms`) and the detector reaches
  `Red-point detector running`. It then dies on the Kafka timeout, which is the correct
  behaviour with no broker. With the build happening inside Azure this was untestable.
- The build no longer depends on an Azure-side build agent.

**What it costs, stated plainly:** `az acr build` uploaded a ~20 KB context and did the heavy
lifting on Azure's network. The first push now sends **~450 MB compressed** from the dev
machine (the image is 951 MB). Later pushes only send the layers the registry lacks.

**Auth:** the registry still has **no admin user** (`admin_enabled = false`), so the push
authenticates with a short-lived ARM token (`az acr login --expose-token`, username = the null
GUID). The token travels through **stdin**, never as `--password`, so it cannot be read from
`ps` on the host. `az` therefore remains a hard requirement of the deploy.

**Preflight:** `scripts/deploy-azure.sh` now fails if no container engine is reachable. Without
that check the apply would die **halfway**, with the registry and the network already created
and billing.

## Bugfix — the layer order made every detector edit re-push 236 MB
*bugfix · 2026-07-14*

Moving the build out of Azure exposed a cost that had always been there and had always been
invisible, because the traffic never left Azure's network.

`COPY red_point_detector.py` sat **before** the two heavy layers of `pipeline/Dockerfile`:

| Layer | Size | Why it was invalidated by a one-line detector edit |
|---|---|---|
| Ivy warm-up (`/opt/ivy`) | 118 MB | it came after the `COPY` |
| `chown -R spark:spark /opt/ivy` | 118 MB | **a second copy of the same cache** |

So editing one line of the detector rebuilt and **re-pushed ~236 MB**.

The second row is the more interesting bug. The `spark` user was created at the BOTTOM of the
Dockerfile, next to `USER`, which forced a **recursive chown over an already-warmed 118 MB
cache**. A recursive chown rewrites every file's metadata, and to the layer diff a rewritten
file is a NEW file — so the image shipped the Ivy cache **twice**.

**Fix (two moves, one idea — put things in lifecycle order):**

1. Create the `spark` user at the TOP, while `/opt/ivy` and `/opt/spark-conf` are still
   **empty** (a chown over nothing is free), and switch to `USER spark` **before** the Ivy
   warm-up. The cache is then written by the user that reads it: no recursive chown, no
   duplicate layer.
2. `COPY` the detector **last**, after every heavy layer. The connector-version assertion moves
   with it (it reads the source), which costs a later failure on a rare mistake and buys a cheap
   edit loop.

**Measured, not asserted:**

| | Before | After |
|---|---|---|
| Image size | 951 MB | **834 MB** |
| Layers invalidated by a detector edit | ~236 MB | **~26 KB** |

Verified by touching `red_point_detector.py` and rebuilding: podman reuses the cache through
step 20 — **including the 118 MB Ivy warm-up** — and rebuilds only the two `COPY` layers and the
assertion. The reordered image was then re-run with `--network none` and behaves identically
(Ivy resolves from `/opt/ivy/cache`, detector reaches "Red-point detector running").

**The general lesson:** a cost that is paid inside someone else's network is a cost nobody
measures. The layer ordering was wrong the whole time; moving the build to a machine whose
uplink we can feel is what made it visible.

## Bugfix — a new dependency taught the cost alarm to lie
*bugfix · 2026-07-14*

Caught by the resilience lens during review, and worth recording because the bug is not where
you would look for it.

Moving the build local gave `terraform apply` a brand-new dependency: a container engine.
`az acr build` never needed one. But `make detector-start` / `make detector-stop`
(`cmd_start` / `cmd_stop`) do this:

```
set_detector_running true     # writes the DESIRED state to terraform.tfvars, on disk
terraform apply               # ...and only now can it fail
```

So on a machine with no podman, with the detector source edited (a changed content hash means
the image must be rebuilt), the apply dies at the image build — **after** the tfvars was
already mutated. Azure is still at 0 replicas; the tfvars now says `detector_running = true`.

And that is exactly the discrepancy `killswitch_guard` is built to detect. The next deploy
would abort announcing **"EL KILL-SWITCH DISPARÓ"** — sending the operator off to audit the
Azure bill, when the real cause is that a binary is missing.

**A cost alarm that misreports its own cause is worse than no alarm**: it spends the one thing
an alarm is supposed to save, which is the operator's attention.

**Fix:** `check_build_engine` now runs
- inside `tf_apply()` — the single funnel every `terraform apply` goes through, so no future
  code path can forget it;
- at the TOP of `cmd_start` / `cmd_stop`, **before** `set_detector_running` writes anything,
  because a check that runs after the state mutation is a check that runs too late;
- in the `guard` subcommand, which is all `make infra-apply` calls before its own apply.

It is memoized so the three call sites do not announce it three times. `terraform destroy`
deliberately does NOT check: destroying builds nothing.

**The transferable lesson:** when you add a dependency, do not only ask "what breaks if it is
missing?" — ask **"what does the failure LOOK like from the other side of the system?"** Here a
missing binary impersonated a blown budget, because a half-finished apply left a lie in the
state file. Ordering matters: never mutate persisted desired-state before the checks that can
still abort.
