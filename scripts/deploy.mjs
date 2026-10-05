// Deliberately a plan printer: this script never invokes gcloud or writes cloud resources.
if (process.argv[2] === '--ollama') {
  const { printCloudRunPlan } = await import('./cloud-run-plan.ts');
  await printCloudRunPlan(process.argv.slice(3));
  process.exit(0);
}
if (process.argv[2] === '--vertex') {
  const { printVertexTrialPlan } = await import('./vertex-trial-plan.ts');
  await printVertexTrialPlan(process.argv.slice(3));
  process.exit(0);
}
const required = ['GCP_PROJECT', 'GCP_REGION', 'CLOUD_RUN_SERVICE', 'CONTAINER_IMAGE'];
const missing = required.filter((key) => !process.env[key]);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;
for (const key of required) {
  if (process.env[key] && !identifier.test(process.env[key])) throw new Error(`${key}: invalid identifier`);
}
const project = process.env.GCP_PROJECT || '<project>';
const region = process.env.GCP_REGION || '<region>';
const service = process.env.CLOUD_RUN_SERVICE || 'ugoku-kami-studio';
const image = process.env.CONTAINER_IMAGE || '<image@sha256:digest>';
console.log('DRY RUN ONLY — リソース作成・デプロイ・IAM変更は行いません。');
console.log(`未設定: ${missing.length ? missing.join(', ') : 'なし'}`);
console.log('別途確認: 課金の明示許可、対象プロジェクト、認証アカウント、実行サービスアカウント、既存レジストリ、Secret Manager、認証付きアクセス。');
console.log('計画（実行されません）:');
console.log(['gcloud run deploy', service, '--project', project, '--region', region, '--image', image, '--port 8080', '--no-allow-unauthenticated', '--min-instances 0', '--max-instances 1', '--concurrency 8', '--set-env-vars AI_PROVIDER=none'].join(' '));
console.log('ローカルGemmaは --ollama、Vertex AIの非公開比較試験は --vertex で別途計画します。VertexはADC、Developer APIのgemini経路はAPIキーを使います。AIアクセスコードとサービス全体の費用対策を確認してください。インスタンス内制限は総課金上限ではありません。');
if (process.argv.includes('--execute')) {
  console.error('--execute は未対応です。確認した計画を、明示許可の対象内で運用者が実行してください。');
  process.exitCode = 1;
}
