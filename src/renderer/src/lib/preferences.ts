export const defaultBaseBranchKey = 'lite-ide.worktree.default-base-branch'

export function loadDefaultBaseBranch(): string {
  try {
    return localStorage.getItem(defaultBaseBranchKey) ?? ''
  } catch {
    return ''
  }
}
