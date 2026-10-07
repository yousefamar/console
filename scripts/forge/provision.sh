#!/usr/bin/env bash
# Provision "forge" — the remote compute box that hosts offloaded agent forks.
#
# Design: research/remote-compute-offload.md in the Console vault project dir.
# Idempotent: safe to re-run; every step checks for an existing resource first.
#
# Transport is SSH-over-SSM, NOT a public SSH port: the security group has ZERO
# inbound rules and the instance has no public-facing service. That also means
# no Tailscale auth key and no human click in the bootstrap path.
#
# Needs admin AWS creds (user/amar, Admin group). The HUB gets its own scoped
# IAM user created here — it may only start/stop/describe THIS instance.
set -euo pipefail

export AWS_PROFILE="${FORGE_AWS_PROFILE:-default}"
export AWS_REGION="${FORGE_REGION:-eu-west-2}"

NAME="${FORGE_NAME:-forge}"
TYPE="${FORGE_INSTANCE_TYPE:-m7i.4xlarge}"
DISK_GB="${FORGE_DISK_GB:-300}"
KEY="${FORGE_SSH_KEY:-$HOME/.ssh/forge_ed25519}"
HUB_CRED_FILE="${FORGE_CRED_FILE:-$HOME/.config/console/forge.json}"
ROLE="$NAME-instance"
PROFILE_NAME="$NAME-instance-profile"
SG_NAME="$NAME-no-inbound"
HUB_USER="console-hub-$NAME"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "Region $AWS_REGION, profile $AWS_PROFILE, instance type $TYPE"
aws sts get-caller-identity --query Arn --output text

# ---------------------------------------------------------------- ssh key
if [ ! -f "$KEY" ]; then
  say "Generating SSH key $KEY"
  ssh-keygen -t ed25519 -N '' -C "console-hub->$NAME" -f "$KEY" >/dev/null
fi
PUBKEY="$(cat "$KEY.pub")"

# ---------------------------------------------------------------- security group
VPC="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  say "Creating security group $SG_NAME (no inbound rules)"
  SG="$(aws ec2 create-security-group --group-name "$SG_NAME" --vpc-id "$VPC" \
    --description "forge: egress only; SSH arrives over SSM" --query GroupId --output text)"
  # A fresh SG has no inbound rules and allow-all egress — exactly what we want.
fi
say "Security group $SG (inbound rule count below must be 0)"
aws ec2 describe-security-groups --group-ids "$SG" --query 'length(SecurityGroups[0].IpPermissions)' --output text

# ---------------------------------------------------------------- instance role
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  say "Creating instance role $ROLE"
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }' >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
# Bedrock so a fork's `claude` runs on the box with NO static keys. Per-person
# cost attribution survives: the owner tag rides the inference-profile ARN that
# taggedModelId() passes, not the calling principal.
aws iam put-role-policy --role-name "$ROLE" --policy-name bedrock-invoke --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow",
    "Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],
    "Resource":"*"}]
}'
if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE"
  say "Waiting for instance profile to propagate"; sleep 12
fi

# ---------------------------------------------------------------- launch
INSTANCE="$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null | head -1)"

if [ -z "$INSTANCE" ] || [ "$INSTANCE" = "None" ]; then
  AMI="$(aws ssm get-parameter \
    --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
    --query 'Parameter.Value' --output text)"
  SUBNET="$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true \
    --query 'Subnets[0].SubnetId' --output text)"
  say "Launching $TYPE from $AMI in $SUBNET"
  USERDATA="$(mktemp)"
  cat > "$USERDATA" <<EOF
#!/bin/bash
set -x
hostnamectl set-hostname $NAME
install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
echo '$PUBKEY' >> /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
install -d -m 0755 -o ubuntu -g ubuntu /srv/git /srv/code /srv/cache
snap start amazon-ssm-agent || systemctl enable --now amazon-ssm-agent || true
EOF
  INSTANCE="$(aws ec2 run-instances \
    --image-id "$AMI" --instance-type "$TYPE" --subnet-id "$SUBNET" \
    --security-group-ids "$SG" \
    --iam-instance-profile "Name=$PROFILE_NAME" \
    --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$DISK_GB,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Purpose,Value=console-agent-offload}]" \
    --user-data "file://$USERDATA" \
    --query 'Instances[0].InstanceId' --output text)"
  rm -f "$USERDATA"
fi
say "Instance $INSTANCE"

STATE="$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].State.Name' --output text)"
if [ "$STATE" = "stopped" ]; then
  say "Starting stopped instance"; aws ec2 start-instances --instance-ids "$INSTANCE" >/dev/null
fi
aws ec2 wait instance-running --instance-ids "$INSTANCE"
say "Running. Waiting for SSM agent to register"
for _ in $(seq 1 60); do
  ok="$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "$ok" = "Online" ] && break
  sleep 10
done
say "SSM ping status: ${ok:-unknown}"

# ---------------------------------------------------------------- hub IAM user
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if ! aws iam get-user --user-name "$HUB_USER" >/dev/null 2>&1; then
  say "Creating scoped hub user $HUB_USER"
  aws iam create-user --user-name "$HUB_USER" >/dev/null
fi
aws iam put-user-policy --user-name "$HUB_USER" --policy-name forge-lifecycle --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"ec2:StartInstances\",\"ec2:StopInstances\"],
     \"Resource\":\"arn:aws:ec2:$AWS_REGION:$ACCOUNT:instance/$INSTANCE\"},
    {\"Effect\":\"Allow\",\"Action\":[\"ec2:DescribeInstances\",\"ec2:DescribeInstanceStatus\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"ssm:StartSession\"],
     \"Resource\":[\"arn:aws:ec2:$AWS_REGION:$ACCOUNT:instance/$INSTANCE\",
                   \"arn:aws:ssm:$AWS_REGION::document/AWS-StartSSHSession\"]},
    {\"Effect\":\"Allow\",\"Action\":[\"ssm:DescribeInstanceInformation\",\"ssm:TerminateSession\",\"ssm:ResumeSession\"],\"Resource\":\"*\"}
  ]
}"

if [ ! -f "$HUB_CRED_FILE" ]; then
  say "Minting access key for $HUB_USER into $HUB_CRED_FILE"
  # Keep the key count at 1: clear any pre-existing keys we have no copy of.
  for k in $(aws iam list-access-keys --user-name "$HUB_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    aws iam delete-access-key --user-name "$HUB_USER" --access-key-id "$k"
  done
  CREDS="$(aws iam create-access-key --user-name "$HUB_USER" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
  AK="$(echo "$CREDS" | cut -f1)"; SK="$(echo "$CREDS" | cut -f2)"
  install -d -m 0700 "$(dirname "$HUB_CRED_FILE")"
  cat > "$HUB_CRED_FILE" <<EOF
{
  "instanceId": "$INSTANCE",
  "region": "$AWS_REGION",
  "host": "$NAME",
  "sshKey": "$KEY",
  "remoteUser": "ubuntu",
  "accessKeyId": "$AK",
  "secretAccessKey": "$SK"
}
EOF
  chmod 600 "$HUB_CRED_FILE"
else
  say "Credential file exists, patching instance id only"
  python3 - "$HUB_CRED_FILE" "$INSTANCE" "$AWS_REGION" <<'PY'
import json, sys
p, iid, region = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p))
d["instanceId"], d["region"] = iid, region
json.dump(d, open(p, "w"), indent=2)
PY
fi

say "Done. Instance=$INSTANCE  SG=$SG (0 inbound)  creds=$HUB_CRED_FILE"
echo "Next: scripts/forge/ssh-setup.sh   then   scripts/forge/bootstrap.sh"
