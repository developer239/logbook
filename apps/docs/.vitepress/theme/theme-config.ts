import type { DefaultTheme } from 'vitepress'
import type { ICliFacts } from '../../scripts/facts.js'

// The default theme's configuration, with what the pages show of the CLI.
export interface IThemeConfig extends DefaultTheme.Config {
  cli: ICliFacts
}
