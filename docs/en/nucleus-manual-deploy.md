> 🇰🇷 [한국어](../nucleus-수동배포.md) | 🇺🇸 English

# Nucleus Collaboration Server Deployment Guide (AWS EC2)

> The complete process of deploying an **Enterprise Nucleus Server** on AWS EC2 for
> Omniverse collaboration (Live concurrent editing). Requires an NGC API key
> (linked to an Omniverse Enterprise license).
> This document records the procedure exactly as it was performed and verified.

---

## 0. Background — Why It Works This Way (as of 2025/2026)

- **Omniverse Launcher was retired on 2025.10.1** → the old free "Nucleus Workstation" install path is gone.
- Nucleus is now distributed only as the **Enterprise Nucleus Server (Docker Compose containers)**.
- The container and compose artifacts sit **behind a license gate in the NGC catalog**
  → you need an **NGC API key** (linked to an Omniverse Enterprise or evaluation license) to download them.

> ⚠️ **Security**: the NGC API key, Nucleus MASTER/SERVICE passwords, and the EC2 key pair (.pem) are credentials.
> Never leave them in plaintext in docs, chats, or code, and rotate them immediately if exposed.

---

## 1. Prerequisites

| Item | Verified value / notes |
|------|------|
| AWS account + EC2 permissions | run-instances, security-group, terminate, etc. |
| NGC API key | `nvapi-...` (linked to an Omniverse Enterprise license) |
| EC2 key pair (.pem) | For SSH access to the new server (e.g. `omni-seoul`) |
| Instance type | **m7i.xlarge** (4 vCPU/16 GB) — Nucleus **does not need a GPU** |
| OS | Ubuntu 22.04 (recommended for Nucleus) |
| Disk | 200 GB gp3 (asset storage) |
| Network | **Same VPC** as the Isaac Sim clients recommended (communicate over private IPs) |

---

## 2. Creating the EC2 Instance

```bash
RG=ap-northeast-2
VPC=vpc-XXXXXXXX               # same VPC as the Isaac Sim machine
SUBNET=subnet-XXXXXXXX         # same subnet (same AZ) recommended
KEY=omni-seoul

# Look up the latest Ubuntu 22.04 AMI (IDs differ per region! Always query in the target region)
AMI=$(aws ec2 describe-images --region $RG --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=state,Values=available" "Name=architecture,Values=x86_64" \
  --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text)

# Security group: allow only SSH + Nucleus ports from inside the VPC (e.g. 172.31.0.0/16)
SG=$(aws ec2 create-security-group --region $RG \
  --group-name nucleus-server-sg --description "Nucleus VPC internal" \
  --vpc-id $VPC --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --region $RG --group-id $SG --ip-permissions \
  "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=3006,ToPort=3030,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=3100,ToPort=3180,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=3333,ToPort=3400,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=8000,ToPort=8080,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=5555,ToPort=5555,IpRanges=[{CidrIp=172.31.0.0/16}]"

# Launch the instance
IID=$(aws ec2 run-instances --region $RG --image-id $AMI --instance-type m7i.xlarge \
  --key-name $KEY --security-group-ids $SG --subnet-id $SUBNET \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=nucleus-server-new}]' \
  --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --region $RG --instance-ids $IID
aws ec2 describe-instances --region $RG --instance-ids $IID \
  --query 'Reservations[0].Instances[0].{Priv:PrivateIpAddress,Pub:PublicIpAddress}' --output json
```

> ⚠️ **Pitfall**: if the shell has `AWS_REGION`/`AWS_DEFAULT_REGION` set to a different region,
> the AMI lookup and instance launch go to the wrong region and fail with errors like `InvalidAMIID.NotFound`.
> If in doubt, `unset AWS_REGION AWS_DEFAULT_REGION` and always pass `--region` explicitly.

Ports used by Nucleus (reference): API 3009/3019, LFT 3030, Discovery 3333, Auth 3100/3180,
Web (Navigator) 8080, Search 3400, Tagging 3020, Metrics 3010, Service 3006/3106, AuthAPI 8000.

---

## 3. Server Prep (SSH In + Install Docker)

```bash
chmod 600 ~/.ssh/omni-seoul.pem
ssh -i ~/.ssh/omni-seoul.pem ubuntu@<PRIVATE_IP>

# On the server, install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo docker compose version    # confirm v2+ is bundled
```

---

## 4. Downloading the Nucleus Stack (NGC)

```bash
# Install the NGC CLI
cd /tmp
curl -L "https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/3.64.2/files/ngccli_linux.zip" -o ngccli.zip
unzip -oq ngccli.zip -d /tmp/ngc

# Authenticate (key via env only)
export NGC_CLI_API_KEY='nvapi-...'
export NGC_CLI_ORG=nvidia
NGC=/tmp/ngc/ngc-cli/ngc

# Find the nucleus compose stack → download it
$NGC registry resource list "nvidia/omniverse*" --format_type csv | grep -i nucleus
#  => nvidia/omniverse/nucleus-compose-stack-pb25h1 (e.g. 2023.2.8)
mkdir -p /tmp/nucleus && cd /tmp/nucleus
$NGC registry resource download-version "nvidia/omniverse/nucleus-compose-stack-pb25h1:2023.2.8"

# Extract → compose and env files live under base_stack/
cd nucleus-compose-stack-pb25h1_v2023.2.8 && tar xzf nucleus-stack-*.tar.gz
```

> Note: searching for a single `nucleus-stack` Docker image finds nothing. Nucleus was split into
> **microservices** (nucleus-api, nucleus-auth, nucleus-discovery, nucleus-lft, navigator, search, ...),
> and the compose stack above ties them together at startup.

---

## 5. Configuration + Secrets + Startup

```bash
# Log in to the nvcr.io registry (to pull images)
echo "$NGC_CLI_API_KEY" | sudo docker login nvcr.io --username '$oauthtoken' --password-stdin

cd <stack>/base_stack

# Set the key entries in nucleus-stack.env
sed -i 's/^ACCEPT_EULA=.*/ACCEPT_EULA=1/' nucleus-stack.env
sed -i 's/^SECURITY_REVIEWED=.*/SECURITY_REVIEWED=1/' nucleus-stack.env
sed -i 's/^SERVER_IP_OR_HOST=.*/SERVER_IP_OR_HOST=<PRIVATE_IP>/' nucleus-stack.env   # the address clients will connect to!
sed -i 's/^INSTANCE_NAME=.*/INSTANCE_NAME=workshop_nucleus/' nucleus-stack.env
sed -i 's|^MASTER_PASSWORD=.*|MASTER_PASSWORD=<strong-password>|' nucleus-stack.env
sed -i 's|^SERVICE_PASSWORD=.*|SERVICE_PASSWORD=<strong-password>|' nucleus-stack.env

# Generate auth secrets (insecure samples, for PoC)
chmod +x generate-sample-insecure-secrets.sh && ./generate-sample-insecure-secrets.sh

# Start (PoC = no-SSL). For production, use nucleus-stack-ssl.yml
sudo docker compose -f nucleus-stack-no-ssl.yml --env-file nucleus-stack.env up -d
```

Key .env entries:
- `ACCEPT_EULA=1`, `SECURITY_REVIEWED=1` (both must be 1 for startup)
- `SERVER_IP_OR_HOST` = **the IP the clients (Isaac Sim) will connect to** — private IP if same VPC, public IP/domain if external
- `MASTER_PASSWORD` = login password for the admin user (`omniverse`)
- `DATA_ROOT=/var/lib/omni/nucleus-data` (where assets are stored)

---

## 6. Verification

```bash
# Are all 12 containers Up?
sudo docker compose -f nucleus-stack-no-ssl.yml --env-file nucleus-stack.env ps

# From a client (same VPC), check ports/web response
for p in 3009 3030 3333 3100 8080 3400; do
  timeout 4 bash -c "echo > /dev/tcp/<PRIVATE_IP>/$p" && echo "$p OK"; done
curl -s -o /dev/null -w "%{http_code}\n" http://<PRIVATE_IP>:8080   # 200 = Navigator OK
# 3333 (discovery) returning 426 (WebSocket upgrade required) is a healthy signal
```

When healthy: 12 containers Up, 8080 → HTTP 200, all key ports open.

---

## 7. Connecting from Isaac Sim (Collaboration)

1. Isaac Sim **Content** panel → **Add New Connection** → enter the server `<PRIVATE_IP>`
2. Log in: `omniverse` / MASTER_PASSWORD
3. Save the scene via **`File → Save As`** to a Nucleus path (`omniverse://<IP>/Projects/...`)
4. Participants open the same USD and enable **Live mode (lightning icon)** → real-time concurrent editing

---

## 7.5 Building a Self-Contained Package (Collect) — For Offline Workshops

By default, saving only uploads the main USD to Nucleus while **assets still reference S3 (the internet)**.
To open the scene in an **environment without internet access**, you need a **Collect** that gathers all
assets and textures into Nucleus.

### Procedure (Isaac Sim GUI)
1. Save the scene to Nucleus first (`File → Save As`).
2. **`Utilities → Collect`** (or right-click the scene in the Content panel → Collect Asset).
3. Destination: `omniverse://<IP>/Projects/<name>_collected/`
4. Recommended options:
   - **USD only** ❌ / **Material only** ❌  (both are partial-collect modes → turn off. Enabling them drops textures = gray)
   - **Flat collection** ⭕ → texture grouping set to **Group by USD** (per-asset folders, avoids name collisions)
     - `Flat` (everything in one folder) risks identical-filename collisions → not recommended
   - **Default prim only** ❌  (enabling it risks dropping some robots)
   - **Convert USDA to USDC** ⭕  (faster loading, smaller size)
5. Start the Collect. With 3,138 warehouse boxes + robots + USDC conversion it takes **several to well over ten minutes**.
   Even if the progress bar seems stuck, it's usually still working. If `du -sh /var/lib/omni/nucleus-data/data`
   on the server keeps growing, it's fine.

### Verification (confirm zero errors)
After the Collect, the Isaac Sim log (`/tmp/isaacsim_launch.log`) must contain no
`can not be found` errors with timestamps **after that point**.
```bash
# Example: count texture-missing errors after 09:50 (must be 0 for success)
awk '/2026-06-27T09:5[0-9]|2026-06-27T1[0-9]:/ && /can not be found/' /tmp/isaacsim_launch.log | wc -l
```

### ⚠️ Pitfall — UDIM textures get dropped by Collect (actually happened)
- Symptom: `References an asset that can not be found: './textures/.../STL_Robot_albedo.<UDIM>.png'`
- Cause: the **iw_hub robot** uses UDIM textures (split across tiles 1001–1004: albedo/normal/orm/emissive),
  and Collect fails to expand the `<UDIM>` token into actual tile numbers, dropping 16 textures → broken package.
- S3 source location (reference): `.../Robots/Idealworks/iwhub/HighResProps/Textures/STL_Robot_<type>.<1001-1004>.png`
- **Fix (adopted)**: since offline self-sufficiency was the goal, **remove the UDIM-using robot (iw_hub) from the scene** and
  re-Collect → zero errors. The workshop robot lineup was finalized at 3 (Nova Carter/Franka/Digit).
- Alternative: manually upload the 16 UDIM textures into the collected `./textures/` location (tedious).

> Lesson: **check for UDIM usage in advance** for any asset going into an offline package. For UDIM-using assets,
> always verify for missing textures after the Collect.

---

## 8. Cleanup / Operations Notes

- **Cleaning up the old instance (this case)**: terminate the old `nucleus-workstation` (t3.xlarge) only after verifying the new server.
  ```bash
  # Run only after confirming the new server is healthy (irreversible)
  aws ec2 terminate-instances --region ap-northeast-2 --instance-ids <OLD_IID>
  ```
  > Ordering principle: **deploy and verify the new server first → then delete the old one.** Never delete the working one first.
- **Moving from PoC to production**: no-SSL → SSL (`nucleus-stack-ssl.yml` + certificates), narrow the access scope, integrate SSO,
  rotate passwords, and replace the insecure secrets with real ones.
- If **external workshop participants** need to connect directly from their own PCs, add their public IPs to the security group
  or set up public access + SSL (if VPC-internal only, connections work only from within the DCV desktop).

---

## Appendix. Common Issues

| Symptom | Cause/Fix |
|------|-----------|
| `InvalidAMIID.NotFound` | Region conflict from shell env vars. `unset AWS_REGION AWS_DEFAULT_REGION` and pass `--region` explicitly |
| Navigator web page loads forever | Security group allows VPC-internal only → **unreachable from outside (local PC)**. Browse to the private IP from inside the DCV desktop, or add your IP to the SG |
| Containers won't start | Check that `ACCEPT_EULA`/`SECURITY_REVIEWED` are 1 and that secrets were generated |
| Clients can't find the server | Check that `SERVER_IP_OR_HOST` is an address reachable from the client (watch the private/public mix-up) |
| NGC pull fails (denied) | Did you `docker login nvcr.io` (user=`$oauthtoken`)? Is the key linked to an Omniverse license? |
