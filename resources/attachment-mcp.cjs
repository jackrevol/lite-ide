const { readFile, stat } = require('node:fs/promises')
const { createInterface } = require('node:readline')

// 각 세션에 지정된 목록만 읽습니다. 모델이 임의의 파일 경로를 요청할 수 없습니다.
const manifest = process.argv[2]
const tool = {
  name: 'resolve_attachment',
  description: 'Resolve an attached file or image referenced inline in the user message as [파일#N]. Call this tool for each referenced attachment before answering about its contents. Returns the original filename and absolute local path. Images also return visual content; for other files, read the returned path with the appropriate file tools. References persist across turns and session resumes.',
  inputSchema: { type: 'object', properties: { reference: { type: 'string', description: 'The exact inline reference, for example [파일#1].' } }, required: ['reference'], additionalProperties: false },
}

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lite-ide-attachments', version: '1.0.0' } }
    case 'ping': return {}
    case 'tools/list': return { tools: [tool] }
    case 'tools/call': {
      if (request.params?.name !== tool.name) throw new Error('지원하지 않는 첨부 도구입니다.')
      const reference = request.params.arguments?.reference
      if (typeof reference !== 'string' || !/^\[파일#\d+\]$/.test(reference)) throw new Error('올바른 첨부 번호를 지정해 주세요.')
      const entry = JSON.parse(await readFile(manifest, 'utf8')).files[reference]
      if (!entry || entry.reference !== reference) throw new Error('이 세션에 해당 첨부 파일이 없습니다.')
      const info = await stat(entry.path)
      if (!info.isFile()) throw new Error('첨부 파일을 읽을 수 없습니다.')
      const content = [{ type: 'text', text: JSON.stringify({ reference, name: entry.name, path: entry.path, kind: entry.kind, size: entry.size }) }]
      if (entry.kind === 'image') {
        const image = entry.imagePath || entry.path
        const bytes = await readFile(image)
        const mimeType = entry.imagePath || /\.png$/i.test(image) ? 'image/png' : /\.jpe?g$/i.test(image) ? 'image/jpeg' : /\.gif$/i.test(image) ? 'image/gif' : 'image/webp'
        content.push({ type: 'image', mimeType, data: bytes.toString('base64') })
      }
      return { content }
    }
    default: throw new Error('지원하지 않는 MCP 요청입니다.')
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', async (line) => {
  let request
  try {
    request = JSON.parse(line)
    if (request.id === undefined) return
    const result = await handle(request)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch (error) {
    if (request?.id === undefined) return
    const result = { isError: true, content: [{ type: 'text', text: error.code === 'ENOENT' ? '첨부 파일이 없거나 아직 준비되지 않았습니다.' : error.message }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  }
})
