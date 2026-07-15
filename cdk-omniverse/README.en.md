> 🇰🇷 [한국어](README.md) | 🇺🇸 English

# CDK — Omniverse Workshop Infrastructure (N Isaac Sim + 1 Nucleus)

The collaboration infrastructure that was originally built by hand (**N Isaac Sim clients + 1 Nucleus server**), codified with AWS CDK (TypeScript). Can be deployed and torn down repeatedly for each workshop.

## What It Creates

- **VPC** (single AZ, public subnet — for PoC)
- **2 security groups**: clients (DCV 8443 + SSH), Nucleus (service ports within the VPC + SSH)
- **2 IAM roles**: SSM access + (Nucleus) NGC secret read
- **1 Nucleus server** (m7i.xlarge) — **Docker+NGC+compose installed automatically via user-data**
- **N Isaac Sim clients** (g6e.2xlarge, default 3) — Marketplace AMI

## Prerequisites

1. **CDK bootstrap** (once per account/region):
   ```bash
   npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2
   ```
2. An existing **EC2 key pair** (e.g. `omni-seoul`).
3. **Isaac Sim Marketplace AMI subscription** + the AMI ID for your region:
   ```bash
   aws ec2 describe-images --region ap-northeast-2 --owners 679593333241 \
     --filters "Name=name,Values=OV-Template-aws-ubuntu-isaac_sim-*" \
     --query 'reverse(sort_by(Images,&CreationDate))[0].{Id:ImageId,Name:Name}'
   ```
4. **NGC API key** — no need to store it in advance. You **enter it at deploy time** (see below).
   The stack accepts it as a NoEcho Parameter, stores it in Secrets Manager, and deletes it on destroy.

## Deployment

Pass the NGC key as a CFN Parameter (`--parameters`), **not** via `-c` (context).
Context values persist in plaintext in the template/`cdk.out`, whereas NoEcho Parameters are masked in the console and logs.

### Recommended: deploy directly with CloudFormation (verified in this environment)

On this workshop server (Isaac Sim AMI), `cdk deploy` fails for two reasons:
1. If `AWS_REGION=us-east-1` is baked into the shell, CDK/SDK deploys there → the Seoul-only AMI/key pair
   does not exist, causing `CREATE_FAILED`. (The `aws` CLI uses the `aws configure` region, so lookups go to Seoul — confusing.)
2. CDK asset uploads (S3 PutObject) hit a smithy socket timeout (`did not establish a connection ... 10000 ms`).

This stack template has no S3 asset references, so it is **self-contained**: synth first, then deploy directly with `aws cloudformation deploy` to bypass both issues:

```bash
npm install

# 1) Synthesize the template (explicitly set AWS_REGION to Seoul)
AWS_REGION=ap-northeast-2 CDK_DEFAULT_REGION=ap-northeast-2 \
npx cdk synth OmniverseWorkshopStack \
  -c keyName=omni-seoul \
  -c isaacAmiId=ami-xxxxxxxxxxxx \
  -c allowCidr=<your-public-IP>/32 \
  -c clientCount=1 -c studentCount=8 > /dev/null

# 2) Deploy directly with CloudFormation (prompt for the NGC key so it stays out of shell history)
read -rs NGC
aws cloudformation deploy \
  --region ap-northeast-2 \
  --stack-name OmniverseWorkshopStack \
  --template-file cdk.out/OmniverseWorkshopStack.template.json \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    NgcApiKey="$NGC" \
    UbuntuPassword=<admin-password> \
    StudentPassword=<shared-participant-password>
unset NGC
```

### Deletion

`cdk destroy` can be silently ignored in this environment (due to the region/deployment issues above), so delete directly and verify the actual state:

```bash
aws cloudformation delete-stack --region ap-northeast-2 --stack-name OmniverseWorkshopStack
aws cloudformation wait stack-delete-complete --region ap-northeast-2 --stack-name OmniverseWorkshopStack
# Verify: describe-stacks returns "does not exist" and the instances are terminated
```

### Alternative: `cdk deploy` (only if the asset socket issue does not occur)

```bash
AWS_REGION=ap-northeast-2 read -rs NGC && npx cdk deploy \
  -c keyName=omni-seoul -c isaacAmiId=ami-xxx -c allowCidr=<your-public-IP>/32 \
  -c clientCount=1 -c studentCount=8 \
  --parameters NgcApiKey="$NGC"; unset NGC
```

### Parameters
**context (`-c key=value`)** — infrastructure shape:
| Parameter | Default | Description |
|----------|--------|------|
| `clientCount` | 3 | Number of Isaac Sim clients (GPU instances) |
| `studentCount` | 8 | **Concurrent participants per client** = number of DCV virtual sessions. Multiple users share one GPU (saves monitoring cost). Recommended 8 for L40S 48GB |
| `clientInstanceType` | g6e.2xlarge | Client instance type (GPU required) |
| `nucleusInstanceType` | m7i.xlarge | Nucleus instance type (no GPU needed) |
| `keyName` | (none) | Name of an existing EC2 key pair |
| `allowCidr` | **(required)** | IP allowed for admin access (DCV 8443, SSH 22) — **must be `<your-public-IP>/32`**. Deployment is blocked if unset or `0.0.0.0/0` |
| `viewerCidr` | falls back to allowCidr | CIDR allowed for viewers (WebRTC streaming) — signaling 49100, media UDP 47998-48010, browser 8210. Use the participants' IP range (e.g. `15.0.0.0/8`). `0.0.0.0/0` is forbidden |
| `isaacAmiId` | (none) | Isaac Sim Marketplace AMI ID (varies per region) |

**CFN Parameters (`--parameters`)** — secrets:
| Parameter | Description |
|----------|------|
| `NgcApiKey` | NGC API key (`nvapi-...`). NoEcho. The stack manages secret creation and deletion |
| `UbuntuPassword` | Password for the ubuntu user (admin DCV/SSH). NoEcho. Set on all clients + Nucleus. Skipped if empty |
| `StudentPassword` | **Shared DCV password for participants (student1..N)**. NoEcho. If empty, the instance generates a random one → recorded in `/opt/dcv-multiuser/CREDENTIALS.txt` |

Example:
```bash
npx cdk deploy -c keyName=omni-seoul -c isaacAmiId=ami-xxx -c allowCidr=<IP>/32 \
  -c clientCount=2 -c studentCount=8 \
  --parameters NgcApiKey=nvapi-xxxx \
  --parameters UbuntuPassword=<admin-password> \
  --parameters StudentPassword=<shared-participant-password>
```

### Multi-User Access (Multiple People per GPU)

At boot, client user-data (`lib/client-userdata.ts`, systemd `dcv-multiuser`) automatically:
1. **Installs nice-xdcv** — the X server for virtual sessions (not included in the Marketplace AMI).
2. **Disables automatic console session creation** — console and virtual sessions cannot coexist.
3. **Pins the GPU Xorg to `:0`** — required because DCV-GL offloads GL to the 3D X server on `:0`.
   Otherwise it falls back to `llvmpipe` (software rendering) and Isaac Sim is unusable. Verify with `dcvgldiag`.
4. **Creates student1..studentCount accounts + virtual sessions**.
5. **Installs nice-dcv-gl + epiphany (browser)** and places the `/usr/local/bin/launch-isaac` launcher.

→ Each participant logs in at `https://<ClientPublicIP>:8443` as **`studentN` / the shared password** and sees the digital twin scene GPU-accelerated in their own virtual session. (One person per account, to avoid home directory/D-Bus conflicts.)

**Launching Isaac Sim (required for multi-user):** In their session terminal, each student must run **`launch-isaac`** instead of calling `isaac-sim.sh` directly. Isaac Sim's HTTP service port (8011) is shared instance-wide, so multiple users launching on the default port die with `address already in use`. The launcher separates ports automatically by uid (student1→8001 … student8→8008):
```bash
launch-isaac          # = ./isaac-sim.sh --/exts/omni.services.transport.server.http/port=<800N>
```
**Nucleus Navigator**: each user opens `epiphany http://<NucleusPrivateIP>:8080` (the AMI's snap firefox does not start in virtual sessions → the deb browser epiphany is pre-installed automatically).

## After Deployment

- The Outputs show the **Nucleus IP, Navigator URL, and per-client DCV URLs**.
- Each client's DCV: `https://<PublicIP>:8443`
  - Admin: `ubuntu` / `UbuntuPassword`
  - Participants: `student1`..`studentN` / `StudentPassword` (shared). Each person logs in with a different studentN.
- If you deployed with an empty participant password, check `/opt/dcv-multiuser/CREDENTIALS.txt` on the client (via SSH).
- Multi-session setup log: `/var/log/dcv-multiuser.log` on the client; status: `systemctl status dcv-multiuser`.
- Nucleus admin password: `/opt/nucleus/CREDENTIALS.txt` on the server (check via SSH).
- Connecting to Nucleus from Isaac Sim: use the **Nucleus private IP** (output `ConnectNucleusFromIsaac`).
- Nucleus auto-install progress/completion: the `/opt/nucleus/READY` file is created on the server.

## Deletion (Cost Cleanup)

```bash
npx cdk destroy
```

## Caveats / Limitations

- The **Marketplace AMI** requires prior subscription consent, and the AMI ID differs per region/version → `isaacAmiId` is required.
- The Marketplace AMI snapshot requires **>=512GB** → the client root volume is fixed at 512GB.
- The user-data Nucleus install is a **no-SSL PoC**. Production needs SSL, SSO, and hardened secrets (`../docs/en/nucleus-manual-deploy.md`).
- The ubuntu password for DCV login relies on the AMI default/manual setup (not baked into CDK for security).
- The PoC uses a public subnet. For production, consider a private subnet + NAT + load balancing.

## Structure

```
cdk-omniverse/
├── bin/cdk-omniverse.ts          # App entry point, parameter parsing
├── lib/
│   ├── omniverse-workshop-stack.ts  # VPC/SG/IAM/EC2 (N+1) definitions
│   └── nucleus-userdata.ts          # Nucleus auto-install user-data (automates the verified manual procedure)
├── package.json
├── tsconfig.json
└── cdk.json
```

## Bugs Caught Through Real Deployments (Verified)

Issues that synth alone could not catch, found and fixed via **actual `deploy` + runtime verification**:

1. **IAM secret permissions** — the `Secret.fromSecretAttributes(secretPartialArn)` + `grantRead` combination
   did not match the real ARN (6-character suffix), causing `AccessDenied`. → Grant the ARN explicitly via `addToPolicy`.
2. **NGC key delivery** — `-c` (context) leaves plaintext in the template/cdk.out. → Switched to a **NoEcho CfnParameter**;
   the stack manages secret creation and deletion.
3. **user-data reboot fragility** — EC2 user-data runs once; if the machine reboots mid-install, it never re-runs.
   → Switched to a **systemd oneshot service (nucleus-install)**: idempotent (skips if READY exists) + `Restart=on-failure`.
4. **Missing tar extraction** — what NGC `download-version` fetches is the
   **`nucleus-stack-....tar.gz` file** inside the `nucleus-compose-stack-..._v2023.2.8/` folder.
   Only after `tar xzf` does `nucleus-stack-2023.2.8*/base_stack` appear.
   The initial script skipped the extraction, so `cd base_stack` failed → compose never ran.
   → Added a `tar xzf` step after download.
5. **SERVER_IP_OR_HOST ends up empty (IMDSv2)** — `curl .../meta-data/local-ipv4` returns an empty value
   on IMDSv2 (token-required) AMIs → `SERVER_IP_OR_HOST=` is blank in `.env` →
   even with all 12 containers up, **Isaac Sim shows "unable to connect"** (discovery advertises an empty address).
   → Fetch the IMDSv2 token first, then query the IP + `hostname -I` fallback + retry on empty.
   If the symptom is "all ports open but only client connections fail", suspect this.

> Final verification: deployed 2 clients, ubuntu password auto-set + DCV login OK,
> Nucleus 12 containers Up + Navigator 200 + **Isaac Sim connection successful**.
