pipeline {
    agent any

    environment {
        AWS_REGION      = 'us-east-1'
        CLUSTER_NAME    = 'auto-healing-mern'
        NAMESPACE       = 'mern-app'
        DEPLOYMENT      = 'mern-api'
        CONTAINER_NAME  = 'mern-api'
        ECR_REPO_URL    = credentials('ecr-repo-url')
        IMAGE_TAG       = "${env.BUILD_NUMBER}"
    }

    options {
        timestamps()
        disableConcurrentBuilds()
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install & Test') {
            steps {
                dir('app') {
                    sh 'npm install'
                    sh 'npm test'
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                dir('app') {
                    sh "docker build -t ${ECR_REPO_URL}:${IMAGE_TAG} -t ${ECR_REPO_URL}:latest ."
                }
            }
        }

        stage('Push to ECR') {
            steps {
                withCredentials([[
                    $class: 'AmazonWebServicesCredentialsBinding',
                    credentialsId: 'aws-credentials'
                ]]) {
                    sh """
                        aws ecr get-login-password --region ${AWS_REGION} | \
                        docker login --username AWS --password-stdin ${ECR_REPO_URL}
                        docker push ${ECR_REPO_URL}:${IMAGE_TAG}
                        docker push ${ECR_REPO_URL}:latest
                    """
                }
            }
        }

        stage('Deploy to EKS') {
            steps {
                withCredentials([[
                    $class: 'AmazonWebServicesCredentialsBinding',
                    credentialsId: 'aws-credentials'
                ]]) {
                    sh """
                        aws eks update-kubeconfig --name ${CLUSTER_NAME} --region ${AWS_REGION}
                        kubectl set image deployment/${DEPLOYMENT} ${CONTAINER_NAME}=${ECR_REPO_URL}:${IMAGE_TAG} -n ${NAMESPACE}
                        kubectl rollout status deployment/${DEPLOYMENT} -n ${NAMESPACE} --timeout=180s
                    """
                }
            }
        }

        stage('Smoke Test') {
            steps {
                withCredentials([[
                    $class: 'AmazonWebServicesCredentialsBinding',
                    credentialsId: 'aws-credentials'
                ]]) {
                    script {
                        def alb = sh(
                            script: "kubectl get ingress mern-api-ingress -n ${NAMESPACE} -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'",
                            returnStdout: true
                        ).trim()
                        def status = sh(
                            script: "curl -s -o /dev/null -w '%{http_code}' http://${alb}/health",
                            returnStdout: true
                        ).trim()
                        if (status != '200') {
                            error("Smoke test failed: /health returned ${status}")
                        }
                        echo "Smoke test passed: ${alb}/health returned 200"
                    }
                }
            }
        }
    }

    post {
        failure {
            withCredentials([[
                $class: 'AmazonWebServicesCredentialsBinding',
                credentialsId: 'aws-credentials'
            ]]) {
                sh """
                    aws eks update-kubeconfig --name ${CLUSTER_NAME} --region ${AWS_REGION}
                    kubectl rollout undo deployment/${DEPLOYMENT} -n ${NAMESPACE}
                """
            }
            echo 'Pipeline failed — rolled back to previous revision.'
        }
        success {
            echo "Deployed ${ECR_REPO_URL}:${IMAGE_TAG} successfully."
        }
        always {
            sh 'docker system prune -f || true'
        }
    }
}
