import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve('src/content/blog');
const privateTermsPath = resolve('../drafts/.private-terms');
const findings = [];

const builtInRules = [
  { label: '이메일 주소', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { label: '휴대전화 번호', pattern: /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g },
  { label: '주민등록번호 형태', pattern: /\b\d{6}[-\s]?\d{7}\b/g },
  { label: '작성자 메타데이터', pattern: /^\s*(author|company|employer|gender|age)\s*:/gim },
];

async function readPrivateTerms() {
  try {
    return (await readFile(privateTermsPath, 'utf8'))
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter((term) => term && !term.startsWith('#'));
  } catch {
    return [];
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (['.md', '.mdx'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const privateTerms = await readPrivateTerms();
const files = await collectFiles(root);

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const rule of builtInRules) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      findings.push(`${relative(process.cwd(), file)}:${line} — ${rule.label}`);
    }
  }
  for (const term of privateTerms) {
    lines.forEach((lineText, index) => {
      if (lineText.toLocaleLowerCase('ko-KR').includes(term.toLocaleLowerCase('ko-KR'))) {
        findings.push(`${relative(process.cwd(), file)}:${index + 1} — 비공개 차단어`);
      }
    });
  }
}

if (findings.length > 0) {
  console.error('공개 콘텐츠에서 민감정보 후보를 발견했습니다.');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log(`민감정보 기본 검사 통과: 공개 글 ${files.length}개`);
