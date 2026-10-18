// PANYA R5D: CI-only, fail-closed Electron Builder debug attribution and quarantine.
// Never output the raw debug YAML, user paths, environment values, or secrets.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(filename), '..');
const BIN = 'builder-debug.yml';
const PIN = Object.freeze({
  sha256: '04876b3e9667bee221095f2ea7517ff3c487eb9d83d1b335abc2cf7d56655c3f',
  size: 1046,
  sourceRun: '39097027464',
  upstreamTag: 'electron-builder@26.17.0',
});
const phases = Object.freeze(['before-build','before-package','after-package']);
const restrictedStrings = [
  /\b(?:GITHUB_TOKEN|GH_TOKEN|Authorization|Bearer|password|api[_-]?key|client[_-]?secret|private[_-]?key|ACCESS_TOKEN|refresh_token|AWS_SECRET)\b/i,
  /(?:github_pat_|gh[pousr]_|sk-proj-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/i,
  /(?:C:[\\/]Users[\\/](?:ADMIN|Administrator)[\\/]|[\\/][.]ssh[\\/]|[\\/]AppData[\\/]Roaming[\\/])/i,
  /(?:https?:\/\/[^\s/@]+:[^\s/@]+@|(?i:token|secret)=\S+)/i,
];
const SHA = /^[a-f0-9]{64}$/i;
function check(ok, code) { if (!ok) throw new Error('R5D_' + code); }
function normalized(p) { return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p); }
function within(parent,child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function fileHash(p) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
}
async function safeDirectory(p, { allowMissing = false } = {}) {
  check(path.isAbsolute(p), 'ROOT_NOT_ABSOLUTE');
  try {
    const item = await lstat(p);
    check(item.isDirectory() && !item.isSymbolicLink(), 'ROOT_REPARSE_OR_NON_DIRECTORY');
    check(normalized(await realpath(p)) === normalized(p), 'ROOT_REALPATH_UNTRUSTED');
    return true;
  } catch(e) {
    if (allowMissing && e?.code === 'ENOENT') return false;
    throw e;
  }
}
async function safeDebugFile(root) {
  const file = path.join(root, BIN);
  try {
    const info = await lstat(file);
    check(info.isFile() && !info.isSymbolicLink() &&
      normalized(await realpath(file)) === normalized(file), 'DEBUG_NOT_CANONICAL_FILE');
    check(info.size >= 1 && info.size <= 8192, 'DEBUG_SIZE_BOUNDS');
    return { present: true, sizeBytes: info.size, sha256: await fileHash(file),
      attributesClass: 'regular_file_no_symlink' };
  } catch(e) {
    if (e?.code === 'ENOENT') return { present: false };
    throw e;
  }
}
function yamlParser() {
  // Resolve only the js-yaml package pinned by electron-builder's own app-builder-lib dependency.
  // No network requests or code execution from YAML values.
  try {
    const desktop = createRequire(path.join(repoRoot,'apps','desktop','package.json'));
    const builder = createRequire(desktop.resolve('electron-builder/package.json'));
    const lib = createRequire(builder.resolve('app-builder-lib/package.json'));
    const yaml = lib('js-yaml');
    check(typeof yaml.load === 'function' && yaml.JSON_SCHEMA, 'YAML_DEPENDENCY_UNTRUSTED');
    return yaml;
  } catch { throw new Error('R5D_PINNED_YAML_PARSER_NOT_FOUND'); }
}
function walk(node, depth, totals, visited) {
  check(depth <= 14 && totals.nodes < 600, 'YAML_COMPLEXITY_LIMIT');
  totals.nodes++;
  if(node === null || typeof node === 'number' || typeof node === 'boolean') return;
  if(typeof node === 'string') {
    check(node.length <= 1536 && !restrictedStrings.some(re=>re.test(node)), 'YAML_SCALAR_SENSITIVE_OR_OVERSIZE');
    return;
  }
  check(typeof node === 'object' && !visited.has(node), 'YAML_ANCHOR_OR_UNSUPPORTED_TYPE');
  visited.add(node);
  if(Array.isArray(node)) {
    check(node.length <= 140, 'YAML_ARRAY_LIMIT');
    node.forEach(x=>walk(x,depth+1,totals,visited));
  } else {
    const keys=Object.keys(node);
    check(keys.length <= 140, 'YAML_OBJECT_LIMIT');
    for(const key of keys){
      check(/^[a-zA-Z0-9_.:/ -]{1,90}$/.test(key) &&
        !restrictedStrings.some(re=>re.test(key)), 'YAML_KEY_UNSAFE');
      walk(node[key],depth+1,totals,visited);
    }
  }
}
export function classifyDebugBytes(bytes, expected = PIN) {
  check(Buffer.isBuffer(bytes), 'SCANNER_INPUT_NOT_BUFFER');
  check(bytes.length === expected.size && bytes.length >= 1 && bytes.length <= 8192,'DEBUG_UNPINNED_SIZE');
  const h=createHash('sha256').update(bytes).digest('hex');
  check(SHA.test(expected.sha256) && h === expected.sha256,'DEBUG_UNPINNED_HASH');
  let txt;
  try { txt = new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { throw new Error('R5D_DEBUG_NOT_UTF8'); }
  check(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(txt) && !restrictedStrings.some(re=>re.test(txt)),
    'DEBUG_SENSITIVE_OR_BINARY_CONTENT');
  const yaml=yamlParser();
  let parsed;
  try { parsed=yaml.load(txt,{schema:yaml.JSON_SCHEMA,json:false}); }
  catch { throw new Error('R5D_UNSAFE_OR_INVALID_YAML'); }
  check(parsed && typeof parsed==='object' && !Array.isArray(parsed), 'YAML_NOT_MAPPING');
  const total={nodes:0};
  walk(parsed,0,total,new WeakSet());
  return Object.freeze({sha256:h,sizeBytes:bytes.length,
    format:'yaml_json_schema_verified',topLevelKeysCount:Object.keys(parsed).length,
    yamlNodeCount:total.nodes,restrictedPatternMatches:0,sourceIdentity:'upstream_debug_logger',
    rawValuesExposed:false});
}
function ensureCI(root,stage) {
  check(process.env.GITHUB_ACTIONS==='true' && process.env.RUNNER_OS==='Windows' &&
    process.env.GITHUB_REPOSITORY==='VAGOO1/lnwjud' &&
    process.env.GITHUB_REF==='refs/heads/panya/native-host-candidate-r5d-20261018' &&
    /^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA || ''), 'GITHUB_CI_IDENTITY');
  const output=path.resolve(process.env.GITHUB_WORKSPACE,'apps','desktop','dist','installers');
  const temp=path.resolve(process.env.RUNNER_TEMP,'PANYA_R5B_GITHUB_STAGING_20261018');
  check(normalized(root)===normalized(output) && normalized(stage)===normalized(temp) &&
    within(process.env.GITHUB_WORKSPACE,root) && within(process.env.RUNNER_TEMP,stage),
    'UNAPPROVED_CI_PATH');
}
async function uniqueJson(file,payload) {
  const contents=JSON.stringify(payload,null,2)+'\n';
  await writeFile(file,contents,{flag:'wx',mode:0o600});
  const saved=await readFile(file,'utf8');
  check(saved===contents,'RECEIPT_READBACK_CHANGED');
}
async function readPhase(stage,phase){
  let d; try {d=JSON.parse(await readFile(path.join(stage,'R5D_'+phase+'.json'),'utf8'));}
  catch { throw new Error('R5D_PHASE_RECEIPT_MISSING'); }
  check(d.schema==='panya-r5d-phase/v1' && d.phase===phase &&
    d.githubRunId===process.env.GITHUB_RUN_ID && d.githubSha===process.env.GITHUB_SHA,
    'PHASE_RECEIPT_IDENTITY_CHANGED');
  return d;
}
async function snapshot(root,stage,phase) {
  check(phases.includes(phase),'UNKNOWN_PHASE');
  const exists=await safeDirectory(root,{allowMissing:true});
  const debug=exists?await safeDebugFile(root):{present:false};
  const receipt={schema:'panya-r5d-phase/v1',phase,githubRunId:process.env.GITHUB_RUN_ID,
    githubSha:process.env.GITHUB_SHA,rootPresent:exists,debug,
    mode:'SANITIZED_METADATA_ONLY',liveModified:false};
  await uniqueJson(path.join(stage,'R5D_'+phase+'.json'),receipt);
  process.stdout.write('R5D_PHASE='+phase+' PRESENT='+debug.present+
    (debug.present?' SHA256='+debug.sha256+' BYTES='+debug.sizeBytes:'')+'\n');
}
async function reviewAndQuarantine(root,stage) {
  check(await safeDirectory(root),'OUTPUT_DIRECTORY_ABSENT');
  const [beforeBuild,beforePackage,afterPackage]=await Promise.all(phases.map(x=>readPhase(stage,x)));
  const current=await safeDebugFile(root);
  const attribution = beforeBuild.debug.present?'PRESENT_BEFORE_BUILD':
    beforePackage.debug.present?'APPEARED_BEFORE_PACKAGE':
    afterPackage.debug.present?'APPEARED_DURING_PACKAGE':'NOT_PRESENT_AFTER_PACKAGE';
  if(current.present){
    check(afterPackage.debug.present && afterPackage.debug.sha256===current.sha256 &&
      afterPackage.debug.sizeBytes===current.sizeBytes,'DEBUG_CHANGED_AFTER_SNAPSHOT');
  }
  const rootNames=(await readdir(root)).sort();
  const expectedNames=current.present?[BIN,'win-unpacked'].sort():['win-unpacked'];
  check(JSON.stringify(rootNames)===JSON.stringify(expectedNames),'UNKNOWN_ROOT_ENTRY');
  check(await safeDirectory(path.join(root,'win-unpacked')),'WIN_UNPACKED_NOT_REAL_DIRECTORY');
  let classification=null, quarantined=false, quarantineSha=null;
  if(current.present) {
    const currentPath=path.join(root,BIN);
    const raw=await readFile(currentPath);
    classification=classifyDebugBytes(raw);
    check(classification.sha256===current.sha256,'SCAN_HASH_CHANGED');
    // Write intent before mutation, so an interrupted move never implies safe completion.
    await uniqueJson(path.join(stage,'R5D_QUARANTINE_INTENT.json'),
      {schema:'panya-r5d-quarantine-intent/v1',githubRunId:process.env.GITHUB_RUN_ID,
       sourceSha256:current.sha256,sourceBytes:current.sizeBytes,attribution,
       inspectedBy:'yaml_json_schema_and_restricted_pattern_scan',plannedMove:true,approvedForLive:false});
    const qroot=path.join(stage,'quarantine');
    await mkdir(qroot,{recursive:false,mode:0o700});
    check(await safeDirectory(qroot),'QUARANTINE_ROOT_UNSAFE');
    const destination=path.join(qroot,BIN);
    try { await lstat(destination); throw new Error('R5D_QUARANTINE_TARGET_EXISTS');}
    catch(e){if(e?.code!=='ENOENT')throw e;}
    await rename(currentPath,destination);
    const moved=await safeDebugFile(qroot);
    check(moved.present && moved.sha256===current.sha256 && moved.sizeBytes===current.sizeBytes,
      'QUARANTINE_READBACK_HASH_MISMATCH');
    const original=await safeDebugFile(root);
    check(!original.present,'ROOT_DEBUG_STILL_PRESENT_AFTER_MOVE');
    quarantineSha=moved.sha256; quarantined=true;
  }
  const finalNames=(await readdir(root)).sort();
  check(JSON.stringify(finalNames)===JSON.stringify(['win-unpacked']),'ROOT_NOT_CLEAN_POST_QUARANTINE');
  const result={
    schema:'panya-r5d-metadata-review/v1',
    repository:process.env.GITHUB_REPOSITORY,
    githubCommit:process.env.GITHUB_SHA,
    githubRunId:process.env.GITHUB_RUN_ID,
    previousR5CRun:PIN.sourceRun,
    upstreamVersion:PIN.upstreamTag,
    phaseAttribution:attribution,
    beforeBuild:beforeBuild.debug,
    beforePackage:beforePackage.debug,
    afterPackage:afterPackage.debug,
    detectedFile:current.present?{name:BIN,sha256:current.sha256,sizeBytes:current.sizeBytes}:null,
    classification,quarantined,quarantineSha256:quarantineSha,
    quarantineContentsPublished:false,
    rootEntriesAfterQuarantine:['win-unpacked'],trustLevel:'CI_STAGE_ONLY_NOT_5090_HOST',
    verdict:'SAFE_QUARANTINED_OR_ABSENT_NOT_YET_PACKAGE_ACCEPTANCE',
  };
  await uniqueJson(path.join(stage,'R5D_METADATA_REVIEW.json'),result);
  process.stdout.write('R5D_METADATA_REVIEW_OK='+JSON.stringify({
    phaseAttribution:attribution,classified:classification!==null,
    quarantined,quarantineSha256:quarantineSha,rootFilesRemaining:0,rawPublished:false})+'\n');
}
async function main(argv){
  check(argv.length===4,'CLI_ARGUMENT_COUNT');
  const [command,phase,rootArg,stageArg]=argv;
  const root=path.resolve(rootArg),stage=path.resolve(stageArg);
  ensureCI(root,stage);
  check(await safeDirectory(stage),'STAGE_DIRECTORY_INVALID');
  if(command==='snapshot') await snapshot(root,stage,phase);
  else if(command==='review' && phase==='none') await reviewAndQuarantine(root,stage);
  else throw new Error('R5D_CLI_COMMAND_UNEXPECTED');
}
if(process.argv[1] && path.resolve(process.argv[1])===filename)
  main(process.argv.slice(2)).catch(e=>{process.stderr.write((e.message?.startsWith('R5D_')?e.message:'R5D_PRIVATE_SCAN_ABORTED')+'\n');process.exitCode=1;});
