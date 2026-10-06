import type { IChildRegistry } from './lib/cli'

declare global {
  namespace App {
    // What the host passes the handler: its child registry, absent under astro dev.
    interface Locals {
      children?: IChildRegistry
    }
  }
}
