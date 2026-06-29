import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeHtml,
  escapeMarkdown,
  generateProjectDocs,
  normalizeManifest,
  normalizeRepositoryUrl,
  renderCapabilitiesHtml,
  renderCapabilitiesMarkdown,
  replaceGeneratedSection,
  validateRepositoryRelativePath,
} from '../scripts/update-project-docs.mjs';

function validManifest() {
  return {
    schemaVersion: 1,
    releaseLinksEnabled: false,
    accountRequirement: 'An account.',
    capabilities: [
      {
        id: 'sample-feature',
        title: 'Sample feature',
        summary: 'A visible behavior.',
        details: [],
        evidence: ['public/index.html'],
      },
    ],
    developmentCommands: [
      {
        id: 'test',
        label: 'Run tests',
        command: 'npm test',
        language: 'bash',
        npmScript: 'test',
        evidence: [],
      },
    ],
    wrapperBuildCommands: [
      {
        id: 'build',
        label: 'Build wrapper',
        command: 'swift build',
        language: 'bash',
        evidence: ['mac/BHyveControllerApp/Package.swift'],
      },
    ],
  };
}

test('generated sections replace only the content between unique markers', () => {
  const source = [
    'Before',
    '<!-- BEGIN GENERATED:SAMPLE -->',
    'old content',
    '<!-- END GENERATED:SAMPLE -->',
    'After',
  ].join('\n');

  assert.equal(
    replaceGeneratedSection(source, 'SAMPLE', 'new content'),
    [
      'Before',
      '<!-- BEGIN GENERATED:SAMPLE -->',
      'new content',
      '<!-- END GENERATED:SAMPLE -->',
      'After',
    ].join('\n'),
  );
  assert.throws(() => replaceGeneratedSection('no markers', 'SAMPLE', 'content'), /Missing or invalid/);
  assert.throws(
    () => replaceGeneratedSection(`${source}\n<!-- BEGIN GENERATED:SAMPLE -->`, 'SAMPLE', 'content'),
    /must be unique/,
  );
});

test('capability renderers escape tracked manifest text for Markdown and HTML contexts', () => {
  const capability = {
    id: 'safe-id',
    title: '<script>*Title*</script>',
    summary: 'Use <strong> & "quotes".',
    details: ['Never render `code` as markup.'],
    evidence: ['public/index.html'],
  };

  const markdown = renderCapabilitiesMarkdown([capability]);
  const html = renderCapabilitiesHtml([capability]);

  assert.doesNotMatch(markdown, /\*Title\*/);
  assert.match(markdown, /\\<script\\>/);
  assert.match(markdown, /\\`code\\`/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.equal(escapeHtml('"\'&<>'), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(escapeMarkdown('*value*'), '\\*value\\*');
});

test('manifest validation rejects unsupported fields, duplicate ids, and unsafe paths', () => {
  const unknownField = validManifest();
  unknownField.extra = true;
  assert.throws(() => normalizeManifest(unknownField), /unsupported field/);

  const duplicate = validManifest();
  duplicate.capabilities.push({ ...duplicate.capabilities[0] });
  assert.throws(() => normalizeManifest(duplicate), /Duplicate capability id/);

  const traversal = validManifest();
  traversal.capabilities[0].evidence = ['../outside.txt'];
  assert.throws(() => normalizeManifest(traversal), /repository-relative path/);
  assert.throws(() => validateRepositoryRelativePath('/absolute.txt'), /repository-relative path/);
  assert.throws(() => validateRepositoryRelativePath('docs/../README.md'), /repository-relative path/);
});

test('release links allow only credential-free HTTPS GitHub repositories', () => {
  assert.equal(
    normalizeRepositoryUrl({ url: 'https://github.com/example/controller.git' }),
    'https://github.com/example/controller',
  );

  const credentialUrl = ['https://user', 'secret@github.com/example/controller'].join(':');
  for (const repository of [
    'http://github.com/example/controller',
    'https://example.com/example/controller',
    credentialUrl,
    'https://github.com/example/controller?ref=main',
    'https://github.com/example/controller#readme',
  ]) {
    assert.throws(() => normalizeRepositoryUrl(repository), /credential-free HTTPS GitHub repository URL/);
  }
});

test('checked-in generated documentation matches its project sources', async () => {
  const result = await generateProjectDocs({ check: true });
  assert.deepEqual(result.changed, []);
});
