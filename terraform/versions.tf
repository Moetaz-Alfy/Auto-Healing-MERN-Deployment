terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }
  }

  # Remote state - create the S3 bucket + DynamoDB table FIRST (see docs/00-bootstrap.md),
  # then uncomment this block and run `terraform init` again to migrate state.
  #
  backend "s3" {
    bucket         = "alfy-tfstate-2026"
    key            = "auto-healing-mern/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
}
