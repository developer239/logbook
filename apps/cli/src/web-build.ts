// The web app's build: the web package's dist/ in the workspace, two directories up from this module in the sources
// and in the build alike. The CLI's bundle replaces this module with one that names dist/web/ beside the bundle.
export const WEB_BUILD = new URL('../../web/dist/', import.meta.url)
