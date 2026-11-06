import { writeFileSync } from 'node:fs'
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write(
  `\x1b[?2004hCodex CLI terminal fixture · ${process.argv[2]}\r\n${process.cwd()}\r\n`,
)
let input = '',
  timer
const prompt = () => process.stdout.write('codex> ')
function run(command) {
  if (command === '/exit') process.exit(0)
  if (command === '/help')
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
if (process.argv[3]) {
  process.stdout.write(`codex> ${process.argv[3]}\r\n`)
  run(process.argv[3])
} else prompt()
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03')) {
    clearInterval(timer)
    timer = undefined
    input = ''
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
})
