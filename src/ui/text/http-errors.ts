import type { HttpRangeErrorKind } from "../../core/source/http-range-source";

interface ErrorText {
  title: string;
  explain: string;
  checks: string[];
  /** curl で再現して確かめる価値があるか（URL の形が不正なときなどは意味が無い） */
  curl: boolean;
}

/**
 * HttpRangeError の種類ごとの説明。
 * 文言を parser 側に持たせず UI に置くのは、core は「何が起きたか」だけを型で返す方針のため。
 */
export const HTTP_ERROR_TEXT: Record<string, ErrorText | undefined> = {
  "invalid-url": {
    title: "URL として解釈できません",
    explain: "https:// から始まる完全な URL を入力してください。",
    checks: [],
    curl: false,
  },
  "mixed-content": {
    title: "https のページから http の URL は読めません（mixed content）",
    explain: "ブラウザは https のページから http への fetch を request 自体送らずに遮断します。サーバ側の問題ではありません。",
    checks: ["同じファイルを https で配信している URL を使う", "手元のサーバなら http://localhost で開いたページから試す（localhost は例外的に許可される）"],
    curl: false,
  },
  cors: {
    title: "サーバには届きますが、CORS で読み取りが許可されていません",
    explain:
      "no-cors の HEAD（中身を読まない診断 request）は応答したので、サーバとネットワークは生きています。" +
      "ブラウザが応答を JS に渡さなかったのは、Access-Control-Allow-Origin にこのページの origin が含まれていないためです。",
    checks: [
      "Access-Control-Allow-Origin: このページの origin（または *）",
      "Access-Control-Allow-Methods: GET, HEAD",
      "Access-Control-Allow-Headers: range（単一範囲の Range は safelisted なので通常は preflight 無しで通るが、許可しておくと確実）",
      "Access-Control-Expose-Headers: ETag, Content-Range（Content-Range が見えないと Archive Size が分からない）",
    ],
    curl: true,
  },
  network: {
    title: "サーバに接続できません",
    explain: "no-cors の診断 request も届きませんでした。CORS 以前に、名前解決・接続・TLS のどこかで失敗しています。",
    checks: ["URL のホスト名の綴り", "オフラインでないか、VPN / プロキシ", "証明書エラー（ブラウザでその URL を直接開くと分かる）"],
    curl: true,
  },
  "http-status": {
    title: "サーバがエラーを返しました",
    explain: "request は届き、CORS も通りましたが、成功ではない status が返りました。",
    checks: ["404: パスの誤り・ファイルが無い", "403: 公開設定・署名付き URL の期限切れ"],
    curl: true,
  },
  "range-not-supported": {
    title: "サーバが HTTP Range Request に対応していません",
    explain:
      "Range を付けた request に 206 Partial Content ではなく 200（ファイル全体）が返りました。" +
      "PMTiles は「必要な範囲だけ読む」ことが前提なので、全体のダウンロードが始まる前に中断しました。",
    checks: ["Accept-Ranges: bytes を返すサーバ・CDN か（S3 / R2 / GCS / GitHub Pages は対応）", "間にあるプロキシや CDN が Range を落としていないか"],
    curl: true,
  },
  "etag-changed": {
    title: "読み取り中にファイルが更新されました",
    explain: "最初の read と後の read で ETag が変わりました。古い directory と新しい tile を混ぜて読むと壊れた Trace になるので止めています。",
    checks: ["開き直す"],
    curl: false,
  },
} satisfies Record<HttpRangeErrorKind, ErrorText>;
