module.exports = {
  extends: [
    '@bsquare',
    '@bsquare/eslint-config/node-app-config',
    'plugin:security/recommended',
  ],
  env: {
    node: true,
  },
  plugins: ['security'],
  rules: {
    // Use base service log infrastructure only!
    'no-console': 'error',
    'id-denylist': [
      'error', // eslint error
      // 'any', // Disabled as any is used as a field name in auth-middleware
      'Number',
      'number',
      'String',
      'string',
      'Boolean',
      'boolean',
      'Undefined',
      // 'undefined' false positive on let x = undefined
    ],
    'security/detect-object-injection': 'off',
  },
  overrides: [
    {
      files: ['src/test/**'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
      }
    }
  ]
};
