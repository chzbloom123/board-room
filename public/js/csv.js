// The one CSV parser and board validator (PLAN standing rule: never a second
// copy). This module is plain ESM with no dependencies so the browser and the
// Fastify server import this exact file.
//
// CSV format (SPEC §5): topic,points,question,answer — one row per question,
// optional header auto-detected, RFC 4180 quoting (embedded commas in quoted
// fields, doubled quotes).

const CONVENTIONAL_POINTS = [100, 200, 300, 400, 500]

// RFC 4180-ish state machine. Returns records of string fields; quoted fields
// may contain commas, doubled quotes, and newlines. Keeps 1-based source line
// numbers for row-level messages.
export function parseCsv(text) {
  const records = []
  let field = ''
  let record = []
  let inQuotes = false
  let line = 1
  let recordStartLine = 1
  let sawAnything = false

  const pushField = () => {
    record.push(field)
    field = ''
  }
  const pushRecord = () => {
    pushField()
    // Skip records that are entirely empty (blank lines).
    if (record.length > 1 || record[0].trim() !== '') {
      records.push({ line: recordStartLine, fields: record })
    }
    record = []
    recordStartLine = line
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    sawAnything = true
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        if (ch === '\n') line++
        field += ch
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === ',') {
      pushField()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      line++
      pushRecord()
    } else {
      field += ch
    }
  }
  if (field !== '' || record.length > 0) pushRecord()

  return sawAnything ? records : []
}

function isHeaderRecord(record) {
  const known = ['topic', 'points', 'question', 'answer']
  const fields = record.fields.map((f) => f.trim().toLowerCase())
  // A header has a non-numeric points column AND names at least one of the
  // expected columns — so a data row with broken points still gets validated
  // as data instead of being silently skipped.
  return !isNumeric(fields[1] ?? '') && fields.some((f) => known.includes(f))
}

function isNumeric(s) {
  return /^-?\d+(\.\d+)?$/.test(s.trim())
}

// Parse + validate CSV text into board topics (SPEC §5).
// Returns { topics, errors, warnings }.
//   errors:   [{ row, message }] — row is the 1-based CSV line; errors block save.
//   warnings: [{ row?, message }] — save is allowed.
export function boardFromCsv(text) {
  const errors = []
  const warnings = []
  const topics = []
  const topicByName = new Map()
  let final = null

  let records = parseCsv(text ?? '')
  if (records.length > 0 && isHeaderRecord(records[0])) {
    records = records.slice(1)
  }
  if (records.length === 0) {
    return {
      topics: [],
      final: null,
      errors: [{ row: 1, message: 'No question rows found' }],
      warnings: [],
    }
  }

  for (const { line, fields } of records) {
    if (fields.length !== 4) {
      errors.push({
        row: line,
        message: `Row ${line}: expected 4 columns (topic,points,question,answer), got ${fields.length}${fields.length > 4 ? ' — wrap fields containing commas in double quotes' : ''}`,
      })
      continue
    }
    const [rawTopic, rawPoints, rawQuestion, rawAnswer] = fields.map((f) => f.trim())

    // Final-round row: the points column is the word "final". The topic
    // column is the final category. At most one per board.
    if (isFinalMarker(rawPoints)) {
      if (final) {
        errors.push({ row: line, message: `Row ${line}: only one final-round row is allowed (first one is on row ${final.row})` })
        continue
      }
      let badFinal = false
      if (rawTopic === '') { errors.push({ row: line, message: `Row ${line}: final round is missing its category` }); badFinal = true }
      if (rawQuestion === '') { errors.push({ row: line, message: `Row ${line}: final round is missing its question` }); badFinal = true }
      if (rawAnswer === '') { errors.push({ row: line, message: `Row ${line}: final round is missing its answer` }); badFinal = true }
      if (!badFinal) final = { row: line, category: rawTopic, question: rawQuestion, answer: rawAnswer }
      continue
    }

    let bad = false
    if (rawTopic === '') {
      errors.push({ row: line, message: `Row ${line}: missing topic` })
      bad = true
    }
    if (rawQuestion === '') {
      errors.push({ row: line, message: `Row ${line}: missing question` })
      bad = true
    }
    if (rawAnswer === '') {
      errors.push({ row: line, message: `Row ${line}: missing answer` })
      bad = true
    }
    if (!isNumeric(rawPoints)) {
      errors.push({
        row: line,
        message: `Row ${line}: points '${rawPoints}' is not a number`,
      })
      bad = true
    }
    if (bad) continue

    const points = Number(rawPoints)
    let topic = topicByName.get(rawTopic)
    if (!topic) {
      topic = { name: rawTopic, cells: [] }
      topicByName.set(rawTopic, topic)
      topics.push(topic)
    }
    if (topic.cells.some((c) => c.points === points)) {
      errors.push({
        row: line,
        message: `Row ${line}: duplicate point value ${points} in topic '${topic.name}'`,
      })
      continue
    }
    topic.cells.push({ points, question: rawQuestion, answer: rawAnswer })
  }

  if (errors.length === 0 && topics.length === 0) {
    errors.push({ row: 1, message: 'No question rows found (a board needs regular questions, not only a final round)' })
  }
  if (errors.length === 0) {
    warnings.push(...boardShapeWarnings(topics))
  }

  return {
    topics,
    final: final ? { category: final.category, question: final.question, answer: final.answer } : null,
    errors,
    warnings,
  }
}

const FINAL_MARKERS = ['final', 'final round', 'final question', 'fj']
function isFinalMarker(points) {
  return FINAL_MARKERS.includes(points.trim().toLowerCase())
}

// Structural validation for an imported final round (same rules as the CSV
// row, minus the row number). null/undefined means "no final round".
export function validateFinal(final) {
  if (final === null || final === undefined) return { errors: [] }
  const errors = []
  if (typeof final !== 'object') return { errors: [{ message: 'Final round must be an object' }] }
  for (const key of ['category', 'question', 'answer']) {
    if (typeof final[key] !== 'string' || final[key].trim() === '') {
      errors.push({ message: `Final round: missing ${key}` })
    }
  }
  return { errors }
}

// Shape warnings (SPEC §5): advisory only, save is allowed. Also used by
// JSON import so both entry paths share one validator.
export function boardShapeWarnings(topics) {
  const warnings = []
  if (topics.length !== 6) {
    warnings.push({
      message: `Board has ${topics.length} topic${topics.length === 1 ? '' : 's'} — the classic shape is 6`,
    })
  }
  const counts = topics.map((t) => t.cells.length)
  if (new Set(counts).size > 1) {
    warnings.push({
      message: `Uneven question counts across topics (${counts.join(', ')}) — cells below the shortest column will be blank`,
    })
  }
  for (const topic of topics) {
    for (const cell of topic.cells) {
      if (!CONVENTIONAL_POINTS.includes(cell.points)) {
        warnings.push({
          message: `Topic '${topic.name}': ${cell.points} points is outside the usual 100–500 convention`,
        })
      }
    }
  }
  return warnings
}

// Structural validation for imported JSON topics — the same rules the CSV
// path enforces, minus row numbers. Returns { errors, warnings } where error
// messages point at topic/cell positions instead of CSV rows.
export function validateTopics(topics) {
  const errors = []
  if (!Array.isArray(topics) || topics.length === 0) {
    return { errors: [{ message: 'No topics found' }], warnings: [] }
  }
  const seenNames = new Set()
  topics.forEach((topic, ti) => {
    const where = `Topic ${ti + 1}`
    if (typeof topic?.name !== 'string' || topic.name.trim() === '') {
      errors.push({ message: `${where}: missing name` })
      return
    }
    if (seenNames.has(topic.name)) {
      errors.push({ message: `${where}: duplicate topic name '${topic.name}'` })
    }
    seenNames.add(topic.name)
    if (!Array.isArray(topic.cells) || topic.cells.length === 0) {
      errors.push({ message: `${where} ('${topic.name}'): no questions` })
      return
    }
    const seenPoints = new Set()
    topic.cells.forEach((cell, ci) => {
      const cellWhere = `${where} ('${topic.name}'), question ${ci + 1}`
      if (typeof cell?.points !== 'number' || !Number.isFinite(cell.points)) {
        errors.push({ message: `${cellWhere}: points is not a number` })
        return
      }
      if (typeof cell.question !== 'string' || cell.question.trim() === '') {
        errors.push({ message: `${cellWhere}: missing question` })
      }
      if (typeof cell.answer !== 'string' || cell.answer.trim() === '') {
        errors.push({ message: `${cellWhere}: missing answer` })
      }
      if (seenPoints.has(cell.points)) {
        errors.push({
          message: `${cellWhere}: duplicate point value ${cell.points} in topic '${topic.name}'`,
        })
      }
      seenPoints.add(cell.points)
    })
  })
  const warnings = errors.length === 0 ? boardShapeWarnings(topics) : []
  return { errors, warnings }
}

function escapeCsvField(value) {
  const s = String(value)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

// Regenerate CSV text from stored topics — the edit screen's source of truth
// (SPEC §6.3). boardFromCsv(csvFromTopics(t)) must deep-equal t.
export function csvFromTopics(topics, final = null) {
  const lines = ['topic,points,question,answer']
  for (const topic of topics) {
    for (const cell of topic.cells) {
      lines.push(
        [topic.name, cell.points, cell.question, cell.answer]
          .map(escapeCsvField)
          .join(','),
      )
    }
  }
  if (final) {
    lines.push([final.category, 'final', final.question, final.answer].map(escapeCsvField).join(','))
  }
  return lines.join('\n') + '\n'
}

// Spreadsheet paste support. Copying cells out of Excel / Google Sheets
// yields tab-separated text; this rewrites it as CSV so the one parser
// above handles it. It is a field-escaping text transform, not a second
// parser: boardFromCsv remains the only thing that interprets rows.
export function looksTabSeparated(text) {
  const lines = (text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return false
  const tabbed = lines.filter((l) => l.includes('\t')).length
  return tabbed >= Math.max(1, Math.ceil(lines.length * 0.8))
}

export function tsvToCsv(text) {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '' : line.split('\t').map((f) => escapeCsvField(f.trim())).join(',')))
    .join('\n')
}
