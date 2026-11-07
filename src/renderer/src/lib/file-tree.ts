import type { ChangedFile } from '../../../shared/types.ts'

export type FileTreeNode = {
  name: string
  path: string
  file?: ChangedFile
  children: FileTreeNode[]
}

export function buildFileTree(files: ChangedFile[], query = ''): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [] }
  const folders = new Map<string, FileTreeNode>([['', root]])
  for (const file of files) {
    if (!file.path.toLowerCase().includes(query.toLowerCase())) continue
    const segments = file.path.split('/')
    let parent = root
    for (let index = 0; index < segments.length - 1; index++) {
      const path = segments.slice(0, index + 1).join('/')
      let folder = folders.get(path)
      if (!folder) {
        folder = { name: segments[index], path, children: [] }
        folders.set(path, folder)
        parent.children.push(folder)
      }
      parent = folder
    }
    parent.children.push({ name: segments.at(-1)!, path: file.path, file, children: [] })
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))
    nodes.forEach((node) => sort(node.children))
  }
  sort(root.children)
  return root.children
}
