# Auto-Healing Web App Deployment — MERN on AWS

A production-style, self-healing deployment: MongoDB + Node/Express API, containerized with
Docker, provisioned on AWS via Terraform, orchestrated on Kubernetes (EKS), deployed through a
Jenkins CI/CD pipeline, and load-balanced with automatic recovery from failed health checks.

## Architecture

```
GitHub push
    │
    ▼
Jenkins  ──build/test──►  Docker image  ──push──►  Amazon ECR
    │
    ▼
kubectl apply / set image
    │
    ▼
EKS Cluster (private subnets, 2 AZs)
    ├─ Deployment (2+ pods, liveness+readiness probes)
    ├─ HPA (scales 2→6 pods on CPU load)
    ├─ Service (ClusterIP)
    └─ Ingress → AWS ALB (health checks, internet-facing)
                     │
                     ▼
                MongoDB Atlas (external, free tier)
```

**Self-healing layers, in order of blast radius:**
| Failure | Mechanism | Recovery |
|---|---|---|
| App hangs/crashes | k8s liveness probe (`/live`) | Pod restarted |
| DB briefly unreachable | k8s readiness probe (`/health`) | Pod pulled from Service, rejoins when healthy |
| Traffic spike | HPA on CPU | Pods scaled 2→6 |
| EC2 node fails | EKS managed node group / ASG health check | Node replaced, pods rescheduled |
| Node unhealthy per ALB | ALB target group health check | Traffic stops routing to it |

---

## 0. Prerequisites

```bash
# Check tool versions
aws --version          # >= 2.x
terraform -version     # >= 1.6
kubectl version --client
docker --version
node --version          # >= 18
```

Configure AWS CLI with an IAM user that has programmatic access (not root):
```bash
aws configure
# AWS Access Key ID, Secret Access Key, region (e.g. us-east-1), output format (json)
```

Set up MongoDB Atlas (free M0 tier) — create a cluster, a database user, and whitelist
`0.0.0.0/0` for the demo (tighten this later), then grab the connection string.

---

## 1. Run the app locally first

```bash
cd app
npm install
docker-compose up --build
```

Test it:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/
curl -X POST http://localhost:3000/items -H "Content-Type: application/json" -d '{"name":"test"}'
curl http://localhost:3000/items
```

Run the test suite:
```bash
npm test
```

---

## 2. Bootstrap Terraform remote state (do this once)

```bash
# Create an S3 bucket for state (bucket names are globally unique - change this)
aws s3api create-bucket \
  --bucket your-unique-tfstate-bucket-name \
  --region us-east-1

aws s3api put-bucket-versioning \
  --bucket your-unique-tfstate-bucket-name \
  --versioning-configuration Status=Enabled

# Create a DynamoDB table for state locking
aws dynamodb create-table \
  --table-name terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Then uncomment the `backend "s3"` block in `terraform/versions.tf` and fill in your bucket name.

---

## 3. Provision AWS infrastructure with Terraform

```bash
cd terraform
terraform init
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
```

This creates: VPC (public/private subnets, IGW, NAT), IAM roles, an EKS cluster, a managed
node group (2–4 nodes, auto-replaced on failure), and an ECR repository.

Grab the outputs:
```bash
terraform output
# cluster_name, cluster_endpoint, ecr_repository_url, vpc_id
```

Point kubectl at the new cluster:
```bash
aws eks update-kubeconfig --name auto-healing-mern --region us-east-1
kubectl get nodes
```

**⚠️ Cost note:** EKS control plane is ~$0.10/hr, plus EC2 nodes and the NAT gateway. Run
`terraform destroy` (step 8) when you're not actively demoing.

---

## 4. Build and push the image manually (first time, before Jenkins is wired up)

```bash
cd app
ECR_REPO=$(terraform -chdir=../terraform output -raw ecr_repository_url)

aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $ECR_REPO

docker build -t $ECR_REPO:v1 .
docker push $ECR_REPO:v1
```

---

## 5. Deploy to Kubernetes

Install cluster add-ons first:
```bash
# metrics-server (required for HPA)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# AWS Load Balancer Controller (required for Ingress -> ALB)
# Follow: https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html
```

Apply the manifests:
```bash
cd k8s
kubectl apply -f 00-namespace.yaml

kubectl create secret generic mongo-secret \
  --namespace mern-app \
  --from-literal=MONGO_URI='your-mongodb-atlas-connection-string'

# Edit 02-deployment.yaml: replace <ECR_REPO_URL> with your actual ECR repo URL
kubectl apply -f 02-deployment.yaml
kubectl apply -f 03-service.yaml
kubectl apply -f 04-ingress.yaml
kubectl apply -f 05-hpa.yaml
```

Watch it come up:
```bash
kubectl get pods -n mern-app -w
kubectl get ingress -n mern-app -w   # wait for ADDRESS to populate (ALB DNS name)
```

Test through the load balancer:
```bash
ALB=$(kubectl get ingress mern-api-ingress -n mern-app -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl http://$ALB/health
```

---

## 6. Wire up Jenkins CI/CD

Quickest path — run Jenkins in Docker locally:
```bash
docker run -d --name jenkins \
  -p 8080:8080 -p 50000:50000 \
  -v jenkins_home:/var/jenkins_home \
  -v /var/run/docker.sock:/var/run/docker.sock \
  jenkins/jenkins:lts
docker exec jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

In the Jenkins UI (`http://localhost:8080`):
1. Install suggested plugins + **Docker Pipeline**, **Kubernetes CLI**, **AWS Credentials**
2. Add credentials: AWS access key/secret, and the ECR repo URL as a secret text credential named `ecr-repo-url`
3. New Pipeline job → "Pipeline script from SCM" → point at your GitHub repo → script path `jenkins/Jenkinsfile`
4. Add a GitHub webhook (repo Settings → Webhooks) pointing at `http://<jenkins-host>:8080/github-webhook/` so pushes trigger builds

From here, every `git push` to main: runs tests → builds the image → pushes to ECR → updates
the k8s Deployment → waits for rollout → smoke-tests the live ALB endpoint → rolls back
automatically on failure.

---

## 7. Prove the self-healing (record this for your portfolio)

**Pod-level recovery:**
```bash
kubectl get pods -n mern-app
kubectl delete pod <pod-name> -n mern-app
kubectl get pods -n mern-app -w   # watch a new one appear within seconds
```

**Liveness probe recovery (simulated crash):**
```bash
curl -X POST http://$ALB/crash
kubectl get pods -n mern-app -w   # watch RESTARTS count increment on that pod
```

**Node-level recovery:**
```bash
# Find an instance backing a node
kubectl get nodes -o wide
# In AWS Console (EC2) or CLI, terminate that instance:
aws ec2 terminate-instances --instance-ids <instance-id>
# Watch the node group replace it and pods reschedule:
kubectl get nodes -w
```

**Autoscaling under load:**
```bash
# Install a load generator, e.g. hey:
#   brew install hey   (or: go install github.com/rakyll/hey@latest)
hey -z 2m -c 50 http://$ALB/

kubectl get hpa -n mern-app -w   # watch REPLICAS climb
```

Record each of these with `asciinema rec` or a screen recorder — this is the actual evidence
of "auto recovery from failed health checks without manual intervention" that your CV claims.

---

## 8. Tear down (avoid ongoing AWS charges)

```bash
kubectl delete -f k8s/
cd terraform
terraform destroy
```

Double-check nothing lingers:
```bash
aws eks list-clusters --region us-east-1
aws ec2 describe-nat-gateways --region us-east-1 --filter Name=state,Values=available
```

---

## Repo layout

```
.
├── app/            Node/Express + MongoDB API
├── terraform/       IaC: VPC, EKS, ECR modules
├── k8s/             Kubernetes manifests (Deployment, Service, Ingress, HPA)
├── jenkins/         Jenkinsfile (CI/CD pipeline)
└── docs/            Architecture diagram, demo recordings/screenshots
```
