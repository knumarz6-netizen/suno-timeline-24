# Render + Supabase 公開メモ

## 構成

- アプリ本体: Render Web Service
- データベース: Supabase Postgres
- ローカル開発: `DATABASE_URL` 未設定なら SQLite のまま動作

この構成にすると、Render の無料インスタンスが再起動しても曲データは Supabase 側に残ります。

## Render で設定する環境変数

- `DATABASE_URL`
  Supabase の接続文字列をそのまま入れます。
- `DATABASE_SSL`
  通常は `require`
- `TRUST_PROXY`
  `true`
- `ABUSE_HASH_SECRET`
  長いランダム文字列
- `ADMIN_PURGE_KEY`
  管理者だけが知る長いランダム文字列

## Supabase 側で取る値

Supabase プロジェクト作成後、`Project Settings > Database` から接続情報を確認します。

使うのは次のどちらかです。

- `Connection string` の URI 形式
- `Direct connection`

Render には `DATABASE_URL` として 1 行で貼り付けます。

例:

```text
postgresql://postgres.xxxxx:password@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres
```

## Render 側の流れ

1. GitHub に push
2. Render で `New > Blueprint`
3. このリポジトリを選ぶ
4. `DATABASE_URL` に Supabase の接続文字列を入力
5. `ADMIN_PURGE_KEY` を入力
6. `Deploy Blueprint`

`render.yaml` で以下は自動設定されます。

- `runtime: node`
- `plan: free`
- `buildCommand: npm install`
- `startCommand: npm start`
- `DATABASE_SSL=require`
- `TRUST_PROXY=true`

## 管理者用の全曲削除ページ

`ADMIN_PURGE_KEY=abcdef123456` の場合、管理者 URL は次です。

```text
https://あなたのRenderのURL/admin/purge/abcdef123456
```

このページから全曲削除できます。

## 補足

- `DATABASE_URL` があると Postgres を使います。
- `DATABASE_URL` がないとローカルの SQLite を使います。
- 無料 Render はスリープするため、最初のアクセスだけ少し遅いことがあります。
