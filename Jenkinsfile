pipeline {
    agent any
    environment {
        IMAGE_NAME = 'clinic-app'
        IMAGE_TAG  = "build-${BUILD_NUMBER}"
        KUBECONFIG = '/var/jenkins_home/.kube/config'
    }
    stages {
        stage('Checkout') {
            steps { checkout scm }
        }
        stage('Test') {
            // テストに失敗すると、ここで止まります（本番には何も反映されません）
            steps {
                dir('app') {
                    sh "docker build --target test -t ${IMAGE_NAME}-test:${IMAGE_TAG} ."
                }
            }
        }
        stage('Build Image') {
            steps {
                dir('app') {
                    sh "docker build --target runtime --build-arg APP_VERSION=${IMAGE_TAG} -t ${IMAGE_NAME}:${IMAGE_TAG} ."
                }
            }
        }
        stage('Load Image into kind') {
            steps {
                sh "kind load docker-image ${IMAGE_NAME}:${IMAGE_TAG} --name demo"
            }
        }
        stage('Deploy Database') {
            steps {
                sh 'kubectl -n clinic get secret clinic-db'
                sh 'kubectl apply -f k8s/postgres.yaml'
                sh 'kubectl -n clinic rollout status statefulset/clinic-db --timeout=240s'
            }
        }
        stage('Deploy App (Rolling Update)') {
            steps {
                script { env.APP_DEPLOYING = 'true' }
                sh "sed 's|clinic-app:IMAGE_TAG|${IMAGE_NAME}:${IMAGE_TAG}|' k8s/app.yaml | kubectl apply -f -"
                sh 'kubectl -n clinic rollout status deployment/clinic-app --timeout=120s'
            }
        }
        stage('Smoke Test') {
            // 本番のPodに、実際にアクセスして確認します（DBへの問い合わせも含みます）
            steps {
                sh '''
                  kubectl -n clinic exec deploy/clinic-app -- wget -qO- http://localhost:3000/api/info | grep "$IMAGE_TAG"
                  kubectl -n clinic exec deploy/clinic-app -- wget -qO- http://localhost:3000/api/departments | grep 内科
                  kubectl -n clinic exec deploy/clinic-app -- wget -qO- http://localhost:3000/api/patients | grep total
                  kubectl -n clinic exec deploy/clinic-app -- wget -qO- http://localhost:3000/api/visits | grep -F '['
                '''
            }
        }
    }
    post {
        success {
            echo "リリース成功: ${IMAGE_NAME}:${IMAGE_TAG}"
        }
        failure {
            script {
                // アプリを入れ替え始めた後の失敗のときだけ、直前の正常なバージョンに戻します
                if (env.APP_DEPLOYING == 'true') {
                    echo '失敗したため、直前のバージョンに自動で戻します'
                    sh 'kubectl -n clinic rollout undo deployment/clinic-app || true'
                } else {
                    echo '本番にはまだ何も反映されていません（旧バージョンのまま稼働中）'
                }
            }
        }
    }
}
