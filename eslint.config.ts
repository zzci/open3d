import antfu from '@antfu/eslint-config'

export default antfu({
  react: true,
  typescript: true,
  ignores: ['apps/web/src/shared/components/ui/**', 'apps/web/src/routeTree.gen.ts'],
}, {
  files: ['apps/web/src/routes/**/*.tsx'],
  rules: {
    'react-refresh/only-export-components': 'off',
  },
})
