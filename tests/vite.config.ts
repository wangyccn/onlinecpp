import { mergeConfig } from 'vite';
import config from '../vite.config';

// Long-running integration tests must not be reloaded when implementation files change.
export default mergeConfig(config, { server: { port: 5174, hmr: false, watch: null } });
