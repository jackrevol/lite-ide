import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write(
  `\x1b[?2004hCodex CLI terminal fixture · ${process.argv[2]}\r\n${process.cwd()}\r\n`,
)
let input = '',
  timer
let pasteBuffer = ''
let images = []
let files = []
const prompt = () => process.stdout.write('codex> ')
function run(command) {
  if (process.argv[5] && /\[파일#\d+\]/.test(command)) {
    const refs = JSON.parse(readFileSync(process.argv[5], 'utf8')).files
    for (const reference of new Set(command.match(/\[파일#\d+\]/g))) {
      const file = refs[reference]
      if (!file) throw new Error(`알 수 없는 첨부: ${reference}`)
      readFileSync(file.path)
      if (file.kind === 'image') images.push(file.path)
      else files.push(file.path)
    }
  }
  if (command.startsWith('IGNORE_IMAGE ')) process.stdout.write(`INLINE_COUNTS:${files.length}:${images.length}:IGNORE_IMAGE\r\n`)
  if (files.length) {
    for (const path of files) readFileSync(path)
    process.stdout.write(`FILE_ATTACHMENTS_READ:${files.length}\r\n`)
    files = []
  }
  if (images.length) {
    for (const path of images) readFileSync(path)
    process.stdout.write(`IMAGE_FILES_READ:${images.length}\r\n`)
    images = []
  }
  if (command === '/exit') process.exit(0)
  if (command === '/cursor-redraw') {
    let remaining = 5
    const redraw = () => {
      process.stdout.write('\x1b[?25l')
      setTimeout(() => {
        process.stdout.write('\x1b[?25h')
        if (--remaining) setTimeout(redraw, 40)
        else { process.stdout.write('CURSOR_DONE:/cursor-redraw\r\n'); prompt() }
      }, 35)
    }
    redraw()
    return
  }
  if (command === '/cursor-fragment') {
    process.stdout.write('\x1b[5')
    setTimeout(() => { process.stdout.write(' q\x1b[?12;25hCURSOR_DONE:/cursor-fragment\r\n'); prompt() }, 40)
    return
  }
  if (command.startsWith('/cursor-')) {
    const sequences = { '/cursor-block': '\x1b[1 q', '/cursor-underline': '\x1b[3 q', '/cursor-bar': '\x1b[5 q', '/cursor-enable': '\x1b[?12;25h', '/cursor-hide': '\x1b[?25l', '/cursor-show': '\x1b[?25h', '/cursor-position': '\x1b7\x1b[2;4H', '/cursor-restore': '\x1b8' }
    const marker = `CURSOR_DONE:${command}\r\n`
    const sequence = sequences[command] ?? ''
    process.stdout.write(command === '/cursor-position' || command === '/cursor-restore' ? marker + sequence : sequence + marker)
  } else if (command === '/child') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    process.stdout.write(`CHILD_PID:${child.pid}\r\n`)
    child.on('exit', () => process.stdout.write(`CHILD_EXIT:${child.pid}\r\n`))
  } else if (command === '/question') {
    process.stdout.write('\x1b]9;Question: fixture reply?\x07')
    process.stdout.write('QUESTION_WAITING\r\n')
  } else if (command === '/help')
    process.stdout.write(
      'Commands: /help /model /status /slow /exit · ! shell\r\n',
    )
  else if (command === '/model')
    process.stdout.write('model: fixture-model\r\n')
  else if (command === '/status')
    process.stdout.write(`cwd: ${process.cwd()}\r\n`)
  else if (command === '/slow') {
    timer = setInterval(() => process.stdout.write('working\r\n'), 100)
    return
  } else if (command.startsWith('write ')) {
    writeFileSync('terminal-created.txt', command.slice(6), 'utf8')
    process.stdout.write('file written\r\n')
  } else process.stdout.write('OK\r\n')
  prompt()
}
images = JSON.parse(process.argv[4] || '[]')
const initialPaths = process.argv[3]?.split('\n\n첨부 파일:\n')[1]
if (initialPaths) files = initialPaths.split('\n').map((path) => JSON.parse(path))
if (process.argv[3]) {
  process.stdout.write(`codex> ${process.argv[3]}\r\n`)
  run(process.argv[3])
} else prompt()
function typed(chunk) {
  if (chunk.includes('\x03')) {
    clearInterval(timer)
    timer = undefined
    input = ''
    images = []
    files = []
    process.stdout.write('^C\r\nINTERRUPTED\r\n')
    prompt()
    return
  }
  const text = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
  for (const char of text) {
    if (char === '\r' || char === '\n') {
      process.stdout.write('\r\n')
      const command = input
      input = ''
      run(command)
    } else if (char === '\x7f' || char === '\b') {
      if (input) {
        input = input.slice(0, -1)
        process.stdout.write('\b \b')
      }
    } else if (char >= ' ') {
      input += char
      process.stdout.write(char)
    }
  }
}
process.stdin.on('data', (chunk) => {
  let remaining = pasteBuffer + chunk
  pasteBuffer = ''
  while (remaining) {
    const start = remaining.indexOf('\x1b[200~')
    if (start < 0) { typed(remaining); return }
    if (start) typed(remaining.slice(0, start))
    const end = remaining.indexOf('\x1b[201~', start + 6)
    if (end < 0) { pasteBuffer = remaining.slice(start); return }
    const pasted = remaining.slice(start + 6, end)
    let path
    try { path = JSON.parse(pasted.trim()) } catch {}
    if (typeof path === 'string' && /\.(png|jpg|gif|webp)$/i.test(path)) {
      readFileSync(path)
      images.push(path)
      const token = `[Image #${images.length}]`
      input += token
      process.stdout.write(token)
    } else {
      if (typeof path === 'string' && existsSync(path)) files.push(path)
      typed(pasted)
    }
    remaining = remaining.slice(end + 6)
  }
})
