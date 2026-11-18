import type { RepositoryCommit } from '../../../shared/types.ts'

export function buildCommitGraph(commits: RepositoryCommit[]) {
  let lanes: string[] = []
  return commits.map((commit) => {
    const incoming = lanes.includes(commit.hash)
    if (!lanes.includes(commit.hash)) lanes.push(commit.hash)
    const before = [...lanes]
    const column = lanes.indexOf(commit.hash)
    lanes.splice(column, 1)
    commit.parents.forEach((parent, index) => {
      if (!lanes.includes(parent)) lanes.splice(index === 0 ? column : lanes.length, 0, parent)
    })
    const lines = before.flatMap((hash, index) => hash === commit.hash ? [] : [{ from: index, to: lanes.indexOf(hash), parent: false }])
    lines.push(...commit.parents.map((parent) => ({ from: column, to: lanes.indexOf(parent), parent: true })))
    return { commit, column, incoming, lines, width: Math.max(before.length, lanes.length, 1) }
  })
}
