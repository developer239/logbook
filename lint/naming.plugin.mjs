const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/u
const INTERFACE_NAME = /^I[A-Z][a-zA-Z0-9]*$/u
const TYPE_PARAMETER_NAME = /^T[A-Z][a-zA-Z]+$/u
const BOOLEAN_NAME = /^(?:is|should|has|can|did|will|expected|does)[A-Z][a-zA-Z0-9]*$/u

const BOOLEAN_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'some',
  'every',
  'test',
  'isArray',
  'isInteger',
  'isFinite',
  'isNaN',
  'isSafeInteger',
  'hasOwn',
  'hasOwnProperty',
])

const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'instanceof', 'in'])

const identifierName = (node) => {
  if (!node) {
    return null
  }
  if (typeof node === 'string') {
    return node
  }
  if (node.type === 'Identifier') {
    return node.name
  }

  return null
}

const isBooleanAnnotation = (identifier) => identifier?.typeAnnotation?.typeAnnotation?.type === 'TSBooleanKeyword'

const isBooleanInitializer = (initializer) => {
  if (!initializer) {
    return false
  }

  switch (initializer.type) {
    case 'Literal':
      return typeof initializer.value === 'boolean'
    case 'UnaryExpression':
      return initializer.operator === '!'
    case 'BinaryExpression':
      return COMPARISON_OPERATORS.has(initializer.operator)
    case 'CallExpression': {
      const { callee } = initializer
      if (callee.type === 'Identifier') {
        return callee.name === 'Boolean'
      }
      if (callee.type === 'MemberExpression' && !callee.computed) {
        return BOOLEAN_METHODS.has(identifierName(callee.property) ?? '')
      }

      return false
    }
    default:
      return false
  }
}

const isBooleanVariable = (declarator) => {
  if (isBooleanAnnotation(declarator.id)) {
    return true
  }
  if (declarator.id.typeAnnotation) {
    return false
  }

  return isBooleanInitializer(declarator.init)
}

const declarationNaming = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce I-prefixed interfaces, T-prefixed type parameters, and camelCase private members',
    },
    schema: [],
    messages: {
      interfaceName: "Interface '{{name}}' must be PascalCase and start with 'I' (e.g. IUserRepository).",
      typeParameterName: "Type parameter '{{name}}' must match ^T[A-Z][a-zA-Z]+$ (e.g. TEntity, TResult).",
      privateMember: "Private member '{{name}}' must be camelCase without a leading underscore.",
    },
  },
  create: (context) => {
    const checkPrivateMemberName = (name, node) => {
      if (name !== null && !CAMEL_CASE.test(name)) {
        context.report({ node, messageId: 'privateMember', data: { name } })
      }
    }

    return {
      TSInterfaceDeclaration: (node) => {
        const name = identifierName(node.id)
        if (name !== null && !INTERFACE_NAME.test(name)) {
          context.report({ node: node.id, messageId: 'interfaceName', data: { name } })
        }
      },
      TSTypeParameter: (node) => {
        const name = identifierName(node.name)
        if (name !== null && !TYPE_PARAMETER_NAME.test(name)) {
          context.report({ node, messageId: 'typeParameterName', data: { name } })
        }
      },
      PropertyDefinition: (node) => {
        if (node.accessibility === 'private' && !node.computed) {
          checkPrivateMemberName(identifierName(node.key), node.key)
        }
      },
      MethodDefinition: (node) => {
        if (node.accessibility === 'private' && !node.computed && node.kind !== 'constructor') {
          checkPrivateMemberName(identifierName(node.key), node.key)
        }
      },
      TSParameterProperty: (node) => {
        if (node.accessibility !== 'private') {
          return
        }

        const { parameter } = node
        const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter
        checkPrivateMemberName(identifierName(target), target)
      },
    }
  },
}

const booleanPrefix = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce intent-bearing prefixes for syntactically identifiable boolean variables',
    },
    schema: [],
    messages: {
      booleanName:
        "Boolean variable '{{name}}' must start with is/should/has/can/did/will/expected/does followed by PascalCase (e.g. isValid, hasAccess).",
    },
  },
  create: (context) => ({
    VariableDeclarator: (node) => {
      if (node.id.type !== 'Identifier') {
        return
      }

      const { name } = node.id
      if (BOOLEAN_NAME.test(name)) {
        return
      }

      if (isBooleanVariable(node)) {
        context.report({ node: node.id, messageId: 'booleanName', data: { name } })
      }
    },
  }),
}

export default {
  meta: { name: 'naming' },
  rules: {
    'declaration-naming': declarationNaming,
    'boolean-prefix': booleanPrefix,
  },
}
