interface SleepBlocker {
  start(type: 'prevent-display-sleep'): number
  stop(id: number): void
}

// 실행 중인 에이전트가 있을 때만 시스템과 화면의 절전을 방지합니다.
export class AwakeService {
  private blockerId: number | undefined
  private closed = false

  private blocker: SleepBlocker

  constructor(blocker: SleepBlocker) {
    this.blocker = blocker
  }

  update(running: boolean) {
    if (running && !this.closed) {
      if (this.blockerId === undefined)
        this.blockerId = this.blocker.start('prevent-display-sleep')
    } else if (this.blockerId !== undefined) {
      this.blocker.stop(this.blockerId)
      this.blockerId = undefined
    }
  }

  close() {
    this.closed = true
    this.update(false)
  }
}
