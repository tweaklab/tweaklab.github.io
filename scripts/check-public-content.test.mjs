import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-public-content.mjs', import.meta.url));

async function check(content) {
  const directory = await mkdtemp(join(tmpdir(), 'public-content-check-'));
  try {
    await mkdir(join(directory, 'src/content/blog'), { recursive: true });
    await writeFile(join(directory, 'src/content/blog/example.md'), content);
    return spawnSync(process.execPath, [checker], { cwd: directory, encoding: 'utf8' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('allows epoch milliseconds in search_after examples', async () => {
  const result = await check('```json\n{"search_after": [1793441730000, 4294967298]}\n```');
  assert.equal(result.status, 0, result.stderr);
});

for (const separator of ['', '-', ' ', '\n']) {
  test(`rejects synthetic resident-number shapes with separator ${JSON.stringify(separator)}`, async () => {
    const result = await check(`개인정보 후보: 900101${separator}1234567`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /주민등록번호 형태/);
  });
}

test('still rejects resident-number shapes inside code blocks', async () => {
  const result = await check('```text\n900101-1234567\n```');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /주민등록번호 형태/);
});

for (const [content, label] of [
  ['test@example.com', '이메일 주소'],
  ['010-1234-5678', '휴대전화 번호'],
  ['author: Example', '작성자 메타데이터'],
]) {
  test(`still rejects ${label}`, async () => {
    const result = await check(content);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(label));
  });
}
