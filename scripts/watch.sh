#!/bin/bash
# 0.5秒ごとにアプリへアクセスし、時刻・バージョン・応答したPodを表示します。
# 失敗した場合は ERROR と、curl の終了コードを表示します（無停止かどうかの確認用）。
while true; do
  r=$(curl -s -m 2 http://localhost:30090/api/info) || r="!!! ERROR (接続失敗 curl終了コード=$?) !!!"
  echo "$(date +%H:%M:%S)  $r"
  sleep 0.5
done
