// CI synthetic-only negative tests for PANYA R5D debug metadata scanner.
// These fixtures are not real builder-debug.yml and do not contain credentials.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { classifyDebugBytes } from '../../scripts/panya-r5d-debug-audit.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fixture = (text, expectedOverrides={}) => {
  const bytes=Buffer.from(text,'utf8');
  return {bytes,expected:{sha256:sha(bytes),size:bytes.length,...expectedOverrides}};
};
const good = 'filePatterns:\n  - "dist/main/**/*"\napp:\n  architecture: x64\n  bundled: true\n';

describe('PANYA R5D debug YAML scanner: private synthetic-only fixtures',()=>{
  it('01 accepts pinned minimal YAML mapping without returning raw fields',()=>{
    const {bytes,expected}=fixture(good);
    const result=classifyDebugBytes(bytes,expected);
    expect(result).toMatchObject({sha256:expected.sha256,sizeBytes:bytes.length,
      rawValuesExposed:false,restrictedPatternMatches:0,format:'yaml_json_schema_verified'});
    expect(JSON.stringify(result)).not.toContain('dist/main');
  });
  it('02 rejects wrong hash independently of any parsed content',()=>{
    const {bytes,expected}=fixture(good,{sha256:'1'.repeat(64)});
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_DEBUG_UNPINNED_HASH');
  });
  it('03 rejects wrong size independently of any parsed content',()=>{
    const {bytes,expected}=fixture(good,{size:1});
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_DEBUG_UNPINNED_SIZE');
  });
  it('04 rejects credential marker without printing the matched value',()=>{
    const {bytes,expected}=fixture('files:\n  password: "SYNTHETIC_PLACEHOLDER"\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow();
  });
  it('05 rejects GitHub PAT prefix without printing the matched value',()=>{
    const {bytes,expected}=fixture('files:\n  - github_pat_SYNTHETIC_PLACEHOLDER\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow();
  });
  it('06 rejects arbitrary YAML tags',()=>{
    const {bytes,expected}=fixture('x: !!js/function "nothing"\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_UNSAFE_OR_INVALID_YAML');
  });
  it('07 rejects malformed YAML document',()=>{
    const {bytes,expected}=fixture('x: [missing closing bracket\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_UNSAFE_OR_INVALID_YAML');
  });
  it('08 rejects binary NUL without surfacing input values',()=>{
    const {bytes,expected}=fixture('key: "hello\u0000"\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_DEBUG_SENSITIVE_OR_BINARY_CONTENT');
  });
  it('09 rejects non-mapping top-level YAML',()=>{
    const {bytes,expected}=fixture('- item\n- second\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_YAML_NOT_MAPPING');
  });
  it('10 rejects duplicate YAML keys',()=>{
    const {bytes,expected}=fixture('x: a\nx: b\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_UNSAFE_OR_INVALID_YAML');
  });
  it('11 rejects excessive payload even with matching hash and size',()=>{
    const {bytes,expected}=fixture('x: '+ 'a'.repeat(9000)+'\n');
    expect(()=>classifyDebugBytes(bytes,expected)).toThrow('R5D_DEBUG_UNPINNED_SIZE');
  });
  it('12 keeps a benign synthetic mapping sanitized',()=>{
    const {bytes,expected}=fixture('files:\n  patterns:\n    - "**/*.js"\n    - "**/*.css"\n');
    const result=classifyDebugBytes(bytes,expected);
    expect(result.topLevelKeysCount).toBe(1);
    expect(result.yamlNodeCount).toBeGreaterThan(3);
    expect(result).not.toHaveProperty('content');
  });
});
