import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardFromCsv, csvFromTopics, looksTabSeparated, tsvToCsv, validateFinal } from '../public/js/csv.js'

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8')

// The fixture table: every fixture, its exact expected errors (by row and
// message pattern) and warnings. A fixture must produce exactly these —
// no more, no fewer (PLAN Phase 3 exit criterion 1).
const TABLE = [
  {
    file: 'valid-classic.csv',
    errors: [],
    warnings: [],
    shape: { topics: 6, cells: [5, 5, 5, 5, 5, 5] },
  },
  {
    file: 'valid-odd-shape.csv',
    errors: [],
    warnings: [/4 topics/i, /uneven/i],
    shape: { topics: 4, cells: [3, 4, 5, 2] },
  },
  {
    file: 'short-row.csv',
    errors: [{ row: 3, match: /expected 4 columns.*got 3/i }],
    warnings: null, // irrelevant when save is blocked
  },
  {
    file: 'bad-points.csv',
    errors: [{ row: 3, match: /points '2OO' is not a number/i }],
    warnings: null,
  },
  {
    file: 'dup-points.csv',
    errors: [{ row: 4, match: /duplicate.*200.*Alpha/i }],
    warnings: null,
  },
  {
    file: 'missing-answer.csv',
    errors: [
      { row: 3, match: /missing answer/i },
      { row: 4, match: /missing question/i },
    ],
    warnings: null,
  },
  {
    file: 'quoted-commas.csv',
    errors: [],
    warnings: [/2 topics/i], // topic count ≠ 6 is a warning, values are conventional
    shape: { topics: 2, cells: [2, 2] },
  },
  {
    file: 'headerless.csv',
    errors: [],
    warnings: [/2 topics/i],
    shape: { topics: 2, cells: [2, 2] },
  },
  {
    file: 'off-convention-points.csv',
    errors: [],
    warnings: [/1 topic\b/i, /50.*outside/i, /250.*outside/i, /1000.*outside/i],
    shape: { topics: 1, cells: [3] },
  },
  {
    file: 'multi-error.csv',
    errors: [
      { row: 3, match: /points 'abc' is not a number/i },
      { row: 4, match: /missing topic/i },
      { row: 5, match: /duplicate.*100.*Alpha/i },
      { row: 6, match: /expected 4 columns.*got 2/i },
      { row: 7, match: /points.*250/i, absent: true }, // 250 is a warning, never an error
    ],
    warnings: null,
  },
]

for (const spec of TABLE) {
  test(`fixture ${spec.file}`, () => {
    const result = boardFromCsv(fixture(spec.file))

    const expectedErrors = spec.errors.filter((e) => !e.absent)
    assert.equal(
      result.errors.length,
      expectedErrors.length,
      `expected ${expectedErrors.length} errors, got: ${JSON.stringify(result.errors)}`,
    )
    for (const expected of spec.errors) {
      const hit = result.errors.find(
        (e) => e.row === expected.row && expected.match.test(e.message),
      )
      if (expected.absent) {
        assert.equal(hit, undefined, `must NOT error on row ${expected.row}`)
      } else {
        assert.ok(
          hit,
          `expected error on row ${expected.row} matching ${expected.match}; got ${JSON.stringify(result.errors)}`,
        )
      }
    }

    if (spec.warnings !== null) {
      assert.equal(
        result.warnings.length,
        spec.warnings.length,
        `expected ${spec.warnings.length} warnings, got: ${JSON.stringify(result.warnings)}`,
      )
      for (const pattern of spec.warnings) {
        assert.ok(
          result.warnings.some((w) => pattern.test(w.message)),
          `expected warning matching ${pattern}; got ${JSON.stringify(result.warnings)}`,
        )
      }
    }

    if (spec.shape) {
      assert.equal(result.topics.length, spec.shape.topics)
      assert.deepEqual(
        result.topics.map((t) => t.cells.length),
        spec.shape.cells,
      )
    }
  })
}

test('quoted fields survive parsing exactly', () => {
  const { topics, errors } = boardFromCsv(fixture('quoted-commas.csv'))
  assert.deepEqual(errors, [])
  assert.equal(topics[0].name, 'Famous Sayings')
  assert.equal(topics[0].cells[0].question, 'Who said "I think, therefore I am"?')
  assert.equal(topics[0].cells[0].answer, 'Descartes, René')
  assert.equal(
    topics[0].cells[1].answer,
    '"...ask what you can do for your country"',
  )
  assert.equal(topics[1].name, 'Punctuation, Grammar')
})

test('header and headerless variants parse to the same board', () => {
  const withHeader = boardFromCsv('topic,points,question,answer\nAlpha,100,Q?,A')
  const without = boardFromCsv('Alpha,100,Q?,A')
  assert.deepEqual(withHeader.topics, without.topics)
  assert.deepEqual(withHeader.errors, [])
  assert.deepEqual(without.errors, [])
})

test('CSV round-trips: topics → csv → identical topics', () => {
  for (const file of ['valid-classic.csv', 'valid-odd-shape.csv', 'quoted-commas.csv']) {
    const first = boardFromCsv(fixture(file))
    assert.deepEqual(first.errors, [])
    const regenerated = csvFromTopics(first.topics)
    const second = boardFromCsv(regenerated)
    assert.deepEqual(second.errors, [])
    assert.deepEqual(second.topics, first.topics, `round-trip failed for ${file}`)
  }
})

test('empty and whitespace-only input is an error, not a crash', () => {
  for (const input of ['', '   \n  \n', 'topic,points,question,answer\n']) {
    const result = boardFromCsv(input)
    assert.ok(result.errors.length > 0, `expected error for ${JSON.stringify(input)}`)
    assert.deepEqual(result.topics, [])
  }
})

test('spreadsheet paste: tab-separated text is detected and converted for the one parser', () => {
  const pasted = [
    'topic\tpoints\tquestion\tanswer',
    'Alpha\t100\tWhat, exactly, is a comma?\tPunctuation',
    'Alpha\t200\tSay "hello"\tGreeting',
    '',
  ].join('\n')
  assert.equal(looksTabSeparated(pasted), true)
  assert.equal(looksTabSeparated('Alpha,100,Q?,A'), false)
  assert.equal(looksTabSeparated(''), false)

  const csv = tsvToCsv(pasted)
  // Commas and quotes survive the transform because fields get CSV-escaped.
  const parsed = boardFromCsv(csv)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.topics, [
    {
      name: 'Alpha',
      cells: [
        { points: 100, question: 'What, exactly, is a comma?', answer: 'Punctuation' },
        { points: 200, question: 'Say "hello"', answer: 'Greeting' },
      ],
    },
  ])
})

test('final round: one "final" row becomes board.final and round-trips through csvFromTopics', () => {
  const parsed = boardFromCsv(fixture('final-round.csv'))
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.final, {
    category: 'Wrap, Up',
    question: 'The closing question, with a comma',
    answer: 'The closing answer',
  })
  assert.equal(parsed.topics.length, 2, 'the final row must not become a topic')

  const again = boardFromCsv(csvFromTopics(parsed.topics, parsed.final))
  assert.deepEqual(again.topics, parsed.topics)
  assert.deepEqual(again.final, parsed.final)

  // No final row → final is null, and csvFromTopics omits it.
  const none = boardFromCsv('Alpha,100,Q?,A')
  assert.equal(none.final, null)
  assert.ok(!csvFromTopics(none.topics, none.final).includes('final'))
})

test('final round: errors for a second final row, a missing answer, and a final-only board', () => {
  const two = boardFromCsv('Alpha,100,Q?,A\nCat,final,FQ?,FA\nCat2,FINAL,FQ2?,FA2')
  assert.equal(two.errors.length, 1)
  assert.match(two.errors[0].message, /only one final-round row/i)
  assert.equal(two.errors[0].row, 3)

  const missing = boardFromCsv('Alpha,100,Q?,A\nCat,final,FQ?,')
  assert.equal(missing.errors.length, 1)
  assert.match(missing.errors[0].message, /final round is missing its answer/i)
  assert.equal(missing.final, null)

  const onlyFinal = boardFromCsv('Cat,final,FQ?,FA')
  assert.ok(onlyFinal.errors.some((e) => /not only a final round/i.test(e.message)))
})

test('validateFinal accepts null and rejects malformed objects', () => {
  assert.deepEqual(validateFinal(null).errors, [])
  assert.deepEqual(validateFinal(undefined).errors, [])
  assert.deepEqual(validateFinal({ category: 'C', question: 'Q', answer: 'A' }).errors, [])
  assert.equal(validateFinal({ category: 'C', question: '' }).errors.length, 2)
  assert.equal(validateFinal('nope').errors.length, 1)
})
