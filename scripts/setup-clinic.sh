#!/bin/bash
# 患者登録デモの「初回だけ」の準備（何度実行しても安全です）
#   1) Kubernetes に clinic 用の専用区画（namespace）を作る
#   2) DBのパスワードを、ランダムな値で Kubernetes の Secret として登録する（Gitには置かない）
#   3) ブラウザから 30090 番で届くように、中継コンテナを起動する
export PATH="$PATH:/usr/local/bin"
set -e
cd "$(dirname "$0")/.."

docker network inspect kind >/dev/null 2>&1 || { echo "NG: kindクラスタがありません。先に cloud-native-demo の手順4-3を実施してください" >&2; exit 1; }

echo "== 1/3 namespace =="
kubectl apply -f k8s/namespace.yaml

echo "== 2/3 DBパスワード（Secret） =="
if kubectl -n clinic get secret clinic-db >/dev/null 2>&1; then
  echo "登録済みのため、そのまま使います"
else
  kubectl -n clinic create secret generic clinic-db \
    --from-literal=password="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

echo "== 3/3 中継コンテナ（30090番） =="
docker compose up -d

echo
echo "準備完了。次は Jenkins にジョブ clinic-pipeline を作り、ビルドしてください。"
