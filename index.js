const App = require("@live-change/framework")
const validators = require("../validation")
const app = new App()

const users = app.createServiceDefinition({
  name: "users",
  validators
})

const userData = require('../config/userData.js')(users)
const userDataDefinition = userData

const userFields = {
  display: {
    type: String
  },
  roles: {
    type: Array,
    of: {
      type: String
    }
  },
  loginMethods: {
    type: Array,
    of: {
      type: Object
    },
    defaultValue: []
  },
  userData: userData.field
}

const User = users.model({
  name: "User",
  properties: {
    ...userFields,
    slug: {
      type: String
    }
  },
  search: userDataDefinition.search,
  indexes: {
    email: {
      property: "userData.email"
    }
  },
  crud: {
    deleteTrigger: true,
    options: {
      access: (params, {client, service}) => {
        if(client.user == params.user) return true
        return client.roles && client.roles.includes('admin')
      }
    }
  }
})

users.action({
  name: "UserCreate",
  properties: {
    ...userFields
  },
  access: (params, { client }) => {
    return client.roles && client.roles.includes('admin')
  },
  async execute (params, { client, service }, emit) {
    const user = app.generateUid()
    let data = { }
    for(let key in userFields) {
      data[key] = params[key]
    }

    data.slug = await service.triggerService('slugs', {
      type: "CreateSlug",
      group: "user",
      to: user
    })
    await service.triggerService('slugs', {
      type: "TakeSlug",
      group: "user",
      path: user,
      to: user,
      redirect: data.slug
    })

    emit({
      type: 'UserCreated',
      user,
      data: {
        ...data,
        display: await userData.getDisplay(data)
      }
    })

    return user
  }
})

users.action({
  name: "UserUpdate", // override CRUD operation
  properties: {
    user: {
      type: User,
      idOnly: true
    },
    roles: {
      type: Array,
      of: {
        type: String
      }
    },
    userData
  },
  returns: {
    type: User,
    idOnly: true
  },
  access: (params, { client }) => {
    return client.roles && client.roles.includes('admin')
  },
  async execute({ user, roles, userData }, context, emit) {
    const userRow = await User.get(user)
    if(!userRow) throw 'notFound'
    emit({
      type: "UserUpdated",
      user,
      data: {
        roles,
        userData,
        display: await userDataDefinition.getDisplay(
            { ...userRow, userData: { ...userRow.userData, ...userData } })
      }
    })
    emit("session", {
      type: "rolesUpdated",
      user,
      roles,
      oldRoles : userRow.roles || []
    })
    return user
  }
})

let updateMethods = { ...userData.updateMethods }
if(userData.formUpdate) {
  updateMethods.updateUserData = userData.formUpdate
}

for(let updateMethodName in updateMethods) {
  const fields = updateMethods[updateMethodName]
  if(!Array.isArray(fields)) continue
  const additionalFields = updateMethods[updateMethodName+'Fields']
  let updateMethodProperties = {}
  for(let fieldName of fields) updateMethodProperties[fieldName] = userData.field.properties[fieldName]
  users.action({
    name: updateMethodName,
    properties: {
      ...updateMethodProperties,
      ...additionalFields
    },
    returns: {
      type: User,
      idOnly: true
    },
    access: (params, { client }) => !!client.user,
    async execute(params, { client }, emit) {
      const userRow = await User.get(client.user)
      if(!userRow) throw 'notFound'
      let cleanData = {}
      for(let fieldName of fields) cleanData[fieldName] = params[fieldName]
      emit({
        type: "UserUpdated",
        user: client.user,
        data: {
          userData: cleanData,
          display: await userData.getDisplay({ ...userRow, userData: { ...userRow.userData, ...cleanData }})
        }
      })
      return client.user
    }
  })
}

let completeUserDataFormProperties = {}
for(let fieldName of userData.formComplete)
  completeUserDataFormProperties[fieldName] = userData.field.properties[fieldName]
users.action({
  name: "completeUserData",
  properties: {
    ...userData.completeFields,
    ...completeUserDataFormProperties
  },
  returns: {
    type: User,
    idOnly: true
  },
  access: (params, { client }) => !!client.user,
  async execute(params, { client }, emit) {
    const userRow = await User.get(client.user)
    if(!userRow) throw 'notFound'
    let cleanData = {}
    for(let fieldName of userData.formComplete) cleanData[fieldName] = params[fieldName]
    emit({
      type: "UserUpdated",
      user: client.user,
      data: {
        userData: cleanData,
        display: await userData.getDisplay({ ...userRow, userData: { ...userRow.userData, ...cleanData }})
      }
    })
    return client.user
  }
})

for(let fieldName of userData.singleFieldUpdates) {
  const props = {}
  props[fieldName] = userData.field.properties[fieldName]
  users.action({
    name: "updateUser" + fieldName.slice(0,1).toUpperCase() + fieldName.slice(1),
    properties: props,
    returns: {
      type: User,
      idOnly: true
    },
    access: (params, { client }) => !!client.user,
    async execute(params, { client }, emit) {
      const userRow = await User.get(client.user)
      if(!userRow) throw 'notFound'
      let updateData = {}
      updateData[fieldName] = params[fieldName]
      emit({
        type: "UserUpdated",
        user: client.user,
        data: {
          userData: updateData,
          display: await userData.getDisplay({ ...userRow, userData: { ...userRow.userData, ...updateData }})
        }
      })
      return client.user
    }
  })
}

users.action({
  name: "deleteMe",
  properties: {
    ...userData.deleteFields
  },
  returns: {
    type: String
  },
  access: (params, { client }) => true, //!!client.user,
  async execute(params, { client, service }, emit) {
    const userRow = await User.get(client.user)
    if(!userRow) throw 'notFound'
    service.trigger({
      type: "UserDeleted",
      user: client.user
    })
    emit({
      type: "UserDeleted",
      user: client.user,
    })
    return 'ok'
  }
})


users.event({
  name: "loginMethodAdded",
  async execute({ user, method }) {
    console.log("LOGIN METHOD ADDED!", method)
    await User.update(user, [{
      op: 'addToSet',
      property: 'loginMethods',
      value: method
    }])
  }
})

users.event({
  name: "loginMethodRemoved",
  async execute({ user, method }) {
    console.log("LOGIN METHOD REMOVED!", method)
    await User.update(user, [{
      op: 'deleteFromSet',
      property: 'loginMethods',
      value: method
    }])
  }
})

let publicUserData = {
  type: Object,
  properties: {}
}
for(let fieldName of userData.publicFields)
  publicUserData.properties[fieldName] = userData.field.properties[fieldName]
async function limitedFieldsPath(user, fields, method) {
  const queryFunc = async function(input, output, { fields, user }) {
    const mapper = function (obj) {
      let out = { id: obj.id, display: obj.display, slug: obj.slug || null }
      for(const field of fields) out[field] = obj.userData[field]
      return out
    }
    await input.table('users_User').object(user).onChange((obj, oldObj) =>
        output.change(obj && mapper(obj), oldObj && mapper(oldObj)) )
  }
  const path = ['database', 'queryObject', app.databaseName, `(${queryFunc})`, { fields, user }]
  return path
}

users.view({
  name: "publicUserData",
  properties: {
    user: {
      type: User
    }
  },
  returns: {
    ...publicUserData
  },
  daoPath({ user }, cd, method) {
    return limitedFieldsPath(user, userData.publicFields, method)
  }
})

if(userData.requiredFields) {
  let requiredUserData = {
    type: Object,
    properties: {}
  }
  for (let fieldName of userData.requiredFields)
    requiredUserData.properties[fieldName] = userData.field.properties[fieldName]
  users.view({
    name: "me",
    properties: {},
    returns: {
      ...requiredUserData
    },
    daoPath(ignore, {client, context}, method) {
      if(!client.user) return null
      return limitedFieldsPath(client.user, userData.requiredFields, method)
    }
  })
}

if(userDataDefinition.publicSearchQuery) {
  users.view({
    name: 'findUsers',
    properties: {
      query: {
        type: String
      },
      subject: {
        type: String
      }
    },
    returns: {
      type: Array,
      of: {
        type: User
      }
    },
    async fetch(params, { client, service }) {
      console.log('SEARCH PARAMS', params)
      const search = await app.connectToSearch()

      const query = await userDataDefinition.publicSearchQuery(params)

      console.log('USER QUERY\n' + JSON.stringify(query, null, '  '))
      const result = await search.search(query)
      console.log('USER SEARCH RESULTS', result.body.hits.total.value)
      return result.body.hits.hits.map(hit => {
        let cleaned = { id: hit._source.id }
        for(const field of userData.publicFields) cleaned[field] = hit._source[field];
        return cleaned
      })
    }
  })
}

if(userDataDefinition.publicSearchQuery || userDataDefinition.adminSearchQuery) {
  users.view({
    name: 'adminFindUsers',
    properties: {
      query: {
        type: String
      },
      subject: {
        type: String
      }
    },
    returns: {
      type: Array,
      of: {
        type: User
      }
    },
    access: (params, { client }) => {
      return client.roles && client.roles.includes('admin')
    },
    async fetch(params, { client, service }) {
      console.log('SEARCH PARAMS', params)
      const search = await app.connectToSearch()

      const query = await (userDataDefinition.adminSearchQuery || userDataDefinition.publicSearchQuery)(params)

      console.log('USER QUERY\n' + JSON.stringify(query, null, '  '))
      const result = await search.search(query)
      //console.log('USER SEARCH RESULTS', result.body)
      return result.body.hits.hits.map(hit => hit._source)
    }
  })
}

module.exports = users

async function start() {
  app.processServiceDefinition(users, [ ...app.defaultProcessors ])
  //console.log(JSON.stringify(users.toJSON(), null, "  "))
  await app.updateService(users)//, { force: true })
  const service = await app.startService(users, { runCommands: true, handleEvents: true })

  /*require("../config/metricsWriter.js")(users.name, () => ({
  }))*/
}

if (require.main === module) start().catch( error => { console.error(error); process.exit(1) })
