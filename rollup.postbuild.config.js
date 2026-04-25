import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';

export default {
  input: 'dist-tsc/services/ag-ui-middleware/src/index.js',
  output: {
    dir: 'dist',
    format: 'esm',
    sourcemap: true,
    preserveModules: true,
    preserveModulesRoot: 'dist-tsc/services/ag-ui-middleware/src',
  },
  external: [
    /^node:/,
    /^@opentelemetry\//,
    '@apollo/server',
    '@graphql-tools/schema',
    'axios',
    'cors',
    'dotenv',
    'eventemitter3',
    'express',
    'express-rate-limit',
    'graphql',
    'graphql-subscriptions',
    'graphql-tag',
    'graphql-ws',
    'helmet',
    'rxjs',
    'uuid',
    'winston',
    'ws',
    'zod',
  ],
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    commonjs(),
  ],
};
