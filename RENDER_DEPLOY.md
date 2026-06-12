# Render 公開手順

## 前提

- このサイトは Render の無料 Web Service で公開できます。
- 無料運用では SQLite は永続化しません。
- 再デプロイや Render 側の再起動でタイムラインが空に戻ることがあります。
- 今回の `24時間で消える` 仕様では、それを許容する前提です。

## 1. GitHub に置く

このフォルダを GitHub リポジトリに push します。

## 2. Render で新規作成

1. Render ダッシュボードで `New > Blueprint` を選ぶ
2. このリポジトリを接続する
3. `render.yaml` を読み込ませる

`render.yaml` には以下を定義済みです。

- `runtime: node`
- `plan: free`
- `buildCommand: npm install`
- `startCommand: npm start`
- `healthCheckPath: /`

## 3. 環境変数を設定する

Render 側で次を設定します。

- `ADMIN_PURGE_KEY`
  管理ページ用の長い秘密文字列
  例: `suno-admin-2026-very-long-random-string`

補足:

- `ABUSE_HASH_SECRET` は `render.yaml` で自動生成されます
- `TRUST_PROXY=true` は設定済みです

## 4. 公開後の管理ページURL

`ADMIN_PURGE_KEY` を `abcdef123456` にした場合、管理ページは次です。

`https://あなたのRenderのURL/admin/purge/abcdef123456`

このURLを知っている人だけが、全曲削除ページを開けます。

## 5. 仕様メモ

- 投稿、いいね、荒らし対策履歴は SQLite に保存されます
- 無料運用ではその SQLite は永続ではありません
- 再デプロイ後にタイムラインが空になっても正常動作です

## 6. 将来 Persistent Disk を付ける場合

有料で Persistent Disk を付ける場合は、Render の環境変数に以下を追加します。

- `DATA_DIR=/data`

そのうえで Render のディスクのマウント先を `/data` にすると、同じコードのまま SQLite を永続化できます。
