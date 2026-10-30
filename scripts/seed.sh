#!/bin/bash
# 架空の患者3名と、1件の受付を登録します（デモの下準備用。すでに登録済みなら 409 と表示されます）
BASE=${1:-http://localhost:30090}
post() {
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2")
  echo "POST $1 -> HTTP $code"
}
post /api/patients '{"name":"山田 太郎","name_kana":"ヤマダ タロウ","birth_date":"1980-04-01","sex":"男"}'
post /api/patients '{"name":"佐藤 花子","name_kana":"サトウ ハナコ","birth_date":"1992-11-23","sex":"女"}'
post /api/patients '{"name":"鈴木 一郎","name_kana":"スズキ イチロウ","birth_date":"1975-07-15","sex":"男"}'
post /api/visits   '{"patient_no":"P000001","department_code":"IM"}'
