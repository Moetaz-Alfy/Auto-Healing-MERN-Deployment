# Auto-Healing MERN Deployment on AWS

A Node.js/Express API backed by MongoDB, deployed to AWS with automated recovery from
infrastructure and application failures. Infrastructure is provisioned with Terraform,
the app runs on Kubernetes (EKS), and Jenkins handles the build and deployment pipeline.

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
    ├─ Deployment (2+ pods, liveness + readiness probes)
    ├─ HPA (scales 2→6 pods under CPU load)
    ├─ Service (ClusterIP)
    └─ Ingress → AWS ALB (health checks, internet-facing)
                     │
                     ▼
                MongoDB Atlas (external)
```

### Failure recovery

| Failure | Detection | Recovery |
|---|---|---|
| App hangs or crashes | Liveness probe (`/live`) | Container restarted in place |
| Database briefly unreachable | Readiness probe (`/health`) | Pod removed from Service, rejoins once healthy |
| Traffic spike | HPA on CPU | Pods scaled 2→6 |
| EC2 node failure | EKS managed node group health check | Node replaced, pods rescheduled |
| Unhealthy target | ALB target group health check | Traffic routed away from it |

## Prerequisites

```bash
aws --version          # >= 2.x
terraform -version     # >= 1.6
kubectl version --client
docker --version
node --version          # >= 18
```

Configure the AWS CLI with an IAM user that has programmatic access (not root):

```bash
aws configure
```

Set up a MongoDB Atlas M0 cluster with a database user and network access configured
for your deployment, then note the connection string.

## Local development

```bash
cd app
npm install
docker-compose up --build
```

```bash
curl http://localhost:3000/health
curl http://localhost:3000/
curl -X POST http://localhost:3000/items -H "Content-Type: application/json" -d '{"name":"test"}'
curl http://localhost:3000/items
npm test
```

## Infrastructure

### 1. Bootstrap Terraform remote state (one-time)

```bash
aws s3api create-bucket --bucket your-unique-tfstate-bucket-name --region us-east-1
aws s3api put-bucket-versioning --bucket your-unique-tfstate-bucket-name --versioning-configuration Status=Enabled

aws dynamodb create-table \
  --table-name terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Uncomment the `backend "s3"` block in `terraform/versions.tf` and set your bucket name.

### 2. Provision AWS resources

```bash
cd terraform
terraform init
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
```

This creates a VPC (public/private subnets, IGW, NAT), IAM roles, an EKS cluster, a
managed node group, and an ECR repository.

```bash
terraform output
aws eks update-kubeconfig --name auto-healing-mern --region us-east-1
kubectl get nodes
```

EKS control plane costs roughly $0.10/hr, plus EC2 and NAT gateway costs. Run
`terraform destroy` when not actively using the environment.

### 3. Initial image build (before CI/CD is wired up)

```bash
cd app
ECR_REPO=$(terraform -chdir=../terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $ECR_REPO
docker build -t $ECR_REPO:v1 .
docker push $ECR_REPO:v1
```

### 4. Deploy to Kubernetes

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
# AWS Load Balancer Controller: https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html

cd k8s
kubectl apply -f 00-namespace.yaml
kubectl create secret generic mongo-secret --namespace mern-app --from-literal=MONGO_URI='your-mongodb-atlas-connection-string'
# Edit 02-deployment.yaml with your ECR repo URL
kubectl apply -f 02-deployment.yaml
kubectl apply -f 03-service.yaml
kubectl apply -f 04-ingress.yaml
kubectl apply -f 05-hpa.yaml
```

```bash
kubectl get pods -n mern-app -w
kubectl get ingress -n mern-app -w
ALB=$(kubectl get ingress mern-api-ingress -n mern-app -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl http://$ALB/health
```

## CI/CD

Jenkins runs the pipeline defined in `jenkins/Jenkinsfile`. On each push to `main`:
tests run, the image builds, it's pushed to ECR, the Kubernetes deployment is updated,
the rollout is verified, the live ALB endpoint is smoke-tested, and a failed deployment
rolls back automatically.

**Setup:**

1. Run Jenkins (Docker, or your preferred host) with access to `docker`, `aws`, and
   `kubectl`.
2. Install the Docker Pipeline, AWS Credentials, and Kubernetes CLI plugins.
3. Add an AWS Credentials entry (ID: `aws-credentials`) and a Secret text credential
   with the ECR repository URL (ID: `ecr-repo-url`).
4. Create a Pipeline job with "Pipeline script from SCM" pointed at this repo, script
   path `jenkins/Jenkinsfile`.
5. Add a GitHub webhook pointing at `http://<jenkins-host>:8080/github-webhook/`, and
   enable "GitHub hook trigger for GITScm polling" on the job.

## Verifying self-healing

**Pod recovery:**
```bash
kubectl delete pod <pod-name> -n mern-app
kubectl get pods -n mern-app -w
```

**Liveness probe recovery:**
```bash
curl -X POST http://$ALB/crash
kubectl get pods -n mern-app -w   # RESTARTS increments on the same pod
```

**Node recovery:**
```bash
kubectl get nodes -o wide
aws ec2 terminate-instances --instance-ids <instance-id>
kubectl get nodes -w
```

**Autoscaling under load:**
```bash
hey -z 2m -c 50 http://$ALB/
kubectl get hpa -n mern-app -w
```

## Teardown

```bash
kubectl delete -f k8s/
cd terraform
terraform destroy
```

Confirm nothing lingers:
```bash
aws eks list-clusters --region us-east-1
aws ec2 describe-nat-gateways --region us-east-1 --filter Name=state,Values=available
```

## Repository layout

```
.
├── app/            Node/Express + MongoDB API
├── terraform/      IaC: VPC, EKS, ECR
├── k8s/            Kubernetes manifests
├── jenkins/        Jenkinsfile
└── docs/           Architecture notes, demo recordings
```
