# SUNO Timeline 引き継ぎメモ

最終更新: 2026-06-14
開発メインフォルダ: `E:\AI\Codex\SUNOタイムライン2`
本番URL: [https://suno-timeline-24.onrender.com/](https://suno-timeline-24.onrender.com/)
GitHub: `knumarz6-netizen/suno-timeline-24`

## 1. このサイトの思想

`SUNO Timeline` は、SUNO の曲リンクを静かに流すためのタイムラインです。

大事にしている考え方:
- できるだけ無駄を省く
- 曲そのものに集中する
- 気になった曲は `OPEN IN SUNO` から元ページへ行ける
- サイト上では、自分が権利を持つ SUNO の曲リンクを貼る前提で案内する
- 投稿者名の概念やプロフィール機能は持たない

現在は「匿名性を強く売りにする」方向ではありません。
あくまで、曲を静かに並べて聴ける場所として整理しています。

## 2. 現在の主要仕様

### タイムライン
- 投稿された曲はタイムラインに表示される
- 曲は投稿から **24時間で自動削除** される
- タイムラインはメンテナンスで予告なく初期化されることがある
- 画面上には寿命メーターを表示する
- 新着投稿は数秒おきの再取得でほぼリアルタイム反映する
- 再生中の曲を止めずにタイムライン表示だけ更新する

### 投稿
- 受け付けるのは SUNO の共有リンク
- `https://suno.com/song/{uuid}`
- `https://suno.com/song/{uuid}?sh=...`
- `https://suno.com/s/{shareCode}`
- 短縮URLでも通常URLでも投稿できるように解決処理あり
- URL入力にはバリデーションあり
- スパム対策として連投制限あり

### プレイヤー
- 画面下に 1 つだけ固定プレイヤーを出す
- 1曲再生すると、その曲が下部プレイヤーで流れる
- 再生中の曲がある状態で別の曲を押すと、そちらへ切り替える
- カード上の `OPEN IN SUNO` から元の SUNO ページへ移動できる

### いいね / 再生回数
- `いいね数` と `再生回数` は全ユーザー共有
- いいねは「同じブラウザからは1回まで」の制御
- 判定はブラウザごとの匿名IDで行う
- 再生回数は共有カウント

### 通報
- 通報はトグル式
- 最後に ON になってから **1時間 ON のまま** なら曲を削除
- OFF に戻すと通報タイマーはリセット
- 寿命メーターは 24時間寿命と通報1時間寿命の短いほうを表示する

### AUTO PLAY
- タイムライン上から順番に曲を流すモードあり
- 通常環境では `AUTO PLAY` / `NEXT` / `STOP` を使う
- iPhone Safari は埋め込みプレイヤーの自動再生制約が強いので、想定通り動かないことがある
- その注意書きをUIに表示している

## 3. UI / デザイン方針

- 白基調で上品、静かで余白のあるデザイン
- 背景に淡いイラストを敷いている
- 派手すぎる装飾は避ける
- 曲カードはなるべく縦を食いすぎないように調整済み
- 下部プレイヤーもコンパクト化済み
- `OPEN IN SUNO` は薄いオレンジ背景
- `AUTO PLAY` は目立つ赤紫系

## 4. 技術構成

### フロントエンド
- `index.html`
- `styles.css`
- `app.js`

### サーバー
- `server.mjs`
- Node.js のシンプルな HTTP サーバー
- フレームワーク未使用
- oEmbed / HTML取得で SUNO メタ情報を解決

### DB
- ローカル既定: `SQLite`
- 本番: `PostgreSQL (Supabase)`
- `DATABASE_URL` があると Postgres を使う
- `DATABASE_URL` がないと SQLite を使う

## 5. 環境の考え方

### ローカル開発
- 普段のローカル確認は SQLite でよい
- SQLite ファイルは `.data/suno-timeline.sqlite`
- ローカルでも `DATABASE_URL` を設定すれば本番DB(Supabase Postgres)を見られる

### 本番環境
- アプリ本体: **Render Web Service (無料枠)**
- DB: **Supabase Postgres (無料枠)**
- Render 無料枠はスリープするため、最初のアクセスだけ遅いことがある
- ただし曲データは Supabase 側に残る

## 6. 本番で使っている主な環境変数

Render 側の主な環境変数:
- `DATABASE_URL`
  - Supabase の接続文字列
- `DATABASE_SSL`
  - `require`
- `TRUST_PROXY`
  - `true`
- `ABUSE_HASH_SECRET`
  - スパム/荒らし対策用のハッシュシークレット
- `ADMIN_PURGE_KEY`
  - 管理者だけが知る全曲削除ページ用キー

補足:
- `ADMIN_PURGE_KEY` を設定すると `/admin/purge/{key}` 形式の管理ページが使える
- このページから全曲削除が可能

## 7. GitHub / リリース運用

### GitHub
- リポジトリ: `knumarz6-netizen/suno-timeline-24`
- 基本ブランチ: `main`

### Render 本番リリース
- `main` に push すると Render が自動デプロイ
- Render 側は Blueprint 管理
- `render.yaml` あり

### いつもの流れ
1. ローカルで修正
2. 動作確認
3. `git status`
4. `git add ...`
5. `git commit -m "..."`
6. `git push origin main`
7. Render の Events でデプロイ確認
8. 本番URLで確認

## 8. ローカルテスト手順

### まずは普通にローカル起動
PowerShell 例:

```powershell
npm start
```

このアプリは既定で `4173` を使う。

ブラウザ:
- [http://localhost:4173/](http://localhost:4173/)
- [http://127.0.0.1:4173/](http://127.0.0.1:4173/)

### 別ポートで起動したいとき
```powershell
$env:PORT='4189'
npm start
```

### npm が使えないとき
Codex 環境では `npm` が見えないことがある。
その場合は Node を直接使う:

```powershell
$env:PORT='4173'
node --use-system-ca server.mjs
```

もし Codex の bundled runtime を使う必要があるなら、過去スレッドでは以下の Node パスで起動確認済み:

```text
C:\Users\rz6_3\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
```

## 9. フォルダ運用の注意

このプロジェクトは元々 `C:\Users\rz6_3\Documents\SUNOタイムライン` にあった。
現在はこのフォルダを本体として使う:

- 現在の本体: `E:\AI\Codex\SUNOタイムライン2`
- 旧フォルダ候補: `E:\AI\Codex\SUNOタイムライン`
- 元フォルダ: `C:\Users\rz6_3\Documents\SUNOタイムライン`

### Git の注意
`E:` 側は環境によって Git が `dubious ownership` を出すことがある。
その場合は一度だけ以下を実行:

```powershell
git config --global --add safe.directory 'E:/AI/Codex/SUNOタイムライン2'
```

## 10. 重要な既知事項

- iPhone Safari は SUNO 埋め込みプレイヤーの自動再生制約が強い
- そのため `AUTO PLAY` は iPhone Safari だけ想定通りに動かない可能性がある
- iPhone Chrome では比較的意図通り動くケースがある
- 下部プレイヤーは UI 微調整を何度か入れているので、余白を触るときは実画面確認推奨
- ローカルは SQLite / 本番は Supabase Postgres という前提を崩さないこと

## 11. 最近の重要な実装・調整

- SUNO短縮URL (`/s/...`) の解決対応
- 24時間での自動削除
- 通報1時間での削除
- 共有いいね数 / 再生回数
- 本番DBを SQLite から Supabase Postgres に切り替え
- Google Search Console 用の `robots.txt` / `sitemap.xml` / 確認HTML 対応
- `Suno` 表記を `SUNO` に統一する方向で調整
- カード上の日付表示から末尾の識別子 (`/ XXXXXXXX`) を削除

## 12. ファイルのざっくり役割

- `server.mjs`
  - API / DB / SUNOリンク解決 / 削除処理 / 管理ページ
- `app.js`
  - タイムライン描画 / いいね / 通報 / AUTO PLAY / 下部プレイヤー制御
- `styles.css`
  - 全体デザイン / カード / 下部プレイヤー / モバイル調整
- `index.html`
  - 静的マークアップ / SEOメタ / UI文言
- `render.yaml`
  - Render Blueprint 設定
- `docs/RENDER_DEPLOY.md`
  - Render + Supabase の公開メモ

## 13. 新しいスレッドで最初に伝えるとよいこと

新しい Codex スレッドを開いたら、最初にこう伝えると早い:

- 開発フォルダは `E:\AI\Codex\SUNOタイムライン2`
- 本番は Render + Supabase Postgres
- ローカル既定は SQLite
- Render は `main` push で自動デプロイ
- iPhone Safari の AUTO PLAY 制約あり
- `docs/CODEX_HANDOFF.md` を前提に続けてほしい

## 14. 補足

もし旧 `E:` 側や `C:` 側が不要になったら、このフォルダで十分に動作確認してから整理するのが安全。

---

このメモは「新しいスレッドに最初に読ませる用」の要約です。
細かい経緯は過去スレッドにあるが、今後の開発はこのファイルを起点にすればだいたい追えるはずです。
