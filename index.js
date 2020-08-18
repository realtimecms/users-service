const App = require("@live-change/framework")
const validators = require("../validation")
const app = new App()

const definition = app.createServiceDefinition({
  name: "users",
  validators
})

const userData = require('../config/userData.js')(definition)
const userDataDefinition = userData

const userFields = {
  display: {
    type: String,
    preview: true,
    view: true
  },
  roles: {
    type: Array,
    of: {
      type: String
    },
    preview: true,
    view: true
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

const User = definition.model({
  name: "User",
  properties: {
    ...userFields,
    online: {
      type: Boolean
    },
    lastOnline: {
      type: Date
    },
    slug: {
      type: String,
      search: {
        type: 'keyword'
      }
    }
  },
  search: userDataDefinition.search,
  indexes: {
    email: {
      property: "userData.email"
    },
    online: {
      property: "online",
      function: async function(input, output) {
        const mapper =
            (obj) => obj.online &&
                ({ id: `${JSON.stringify(obj.timestamp)}_${obj.id}`, to: obj.id })
        await input.table('users_User').onChange(
            (obj, oldObj) => output.change(obj && mapper(obj), oldObj && mapper(oldObj))
        )
      }
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

definition.action({
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

definition.action({
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
    userData: userData.field
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

async function getRightSlug(userRow, updatedUserData, service) {
  const slugParams = { user: userRow.id, userData: { ...userRow.userData, ...updatedUserData } }
  let slug = userRow.slug
  if(userData.isSlugRight && !await userData.isSlugRight(slug, slugParams, service)) {
    console.log("CHANGING SLUG!")
    slug = await userData.createSlug(slugParams, service)
    await service.triggerService('slugs', {
      type: "RedirectSlug",
      group: "user",
      path: userRow.slug,
      redirect: slug
    })
    console.log("SLUG", userRow.slug, "REDIRECTED TO", slug)
  }
  return slug
}

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
  definition.action({
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
    async execute(params, { client, service }, emit) {
      const userRow = await User.get(client.user)
      if(!userRow) throw 'notFound'
      let cleanData = {}
      for(let fieldName of fields) cleanData[fieldName] = params[fieldName]
      const slug = await getRightSlug(userRow, cleanData, service)
      emit({
        type: "UserUpdated",
        user: client.user,
        data: {
          slug,
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
definition.action({
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
  async execute(params, { client, service }, emit) {
    const userRow = await User.get(client.user)
    if(!userRow) throw 'notFound'
    let cleanData = {}
    for(let fieldName of userData.formComplete) cleanData[fieldName] = params[fieldName]

    const slug = await getRightSlug(userRow, cleanData, service)

    emit({
      type: "UserUpdated",
      user: client.user,
      data: {
        slug,
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
  definition.action({
    name: "updateUser" + fieldName.slice(0,1).toUpperCase() + fieldName.slice(1),
    properties: props,
    returns: {
      type: User,
      idOnly: true
    },
    access: (params, { client }) => !!client.user,
    async execute(params, { client, service }, emit) {
      const userRow = await User.get(client.user)
      if(!userRow) throw 'notFound'
      let updateData = {}
      updateData[fieldName] = params[fieldName]
      const slug = await getRightSlug(userRow, updateData, service)
      emit({
        type: "UserUpdated",
        user: client.user,
        data: {
          slug,
          userData: updateData,
          display: await userData.getDisplay({ ...userRow, userData: { ...userRow.userData, ...updateData }})
        }
      })
      return client.user
    }
  })
}

definition.action({
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
    /*emit({
      type: "loggedOut",
      session
    })
    return 'ok' // testing */
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


definition.event({
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

definition.event({
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
  properties: {
    display: {
      type: String
    },
    slug: {
      type: String
    },
    ...(userData.online && userData.online.public ? {
      online: {
        type: Boolean
      },
      lastOnline: {
        type: Date
      }
    } : {})
  }
}
for(let fieldName of userData.publicFields)
  publicUserData.properties[fieldName] = userData.field.properties[fieldName]
async function limitedFieldsPath(user, fields, method) {
  let queryFunc
  if(userData.online && userData.online.public) {
    queryFunc = async function(input, output, { fields, user }) {
      const mapper = function (obj) {
        if(!obj.userData) return null // deleted users
        let out = {
          id: obj.id,
          display: obj.display,
          slug: obj.slug || null,
          online: obj.online,
          lastOnline: obj.lastOnline
        }
        for(const field of fields) out[field] = obj.userData[field]
        return out
      }
      await input.table('users_User').object(user).onChange((obj, oldObj) =>
          output.change(obj && mapper(obj), oldObj && mapper(oldObj)) )
    }
  } else {
    queryFunc = async function(input, output, { fields, user }) {
      const mapper = function(obj) {
        if(!obj.userData) return null // deleted users
        let out = {
          id: obj.id,
          display: obj.display,
          slug: obj.slug || null
        }
        for(const field of fields) out[field] = obj.userData[field]
        return out
      }
      await input.table('users_User').object(user).onChange((obj, oldObj) =>
          output.change(obj && mapper(obj), oldObj && mapper(oldObj)))
    }
  }
  const path = ['database', 'queryObject', app.databaseName, `(${queryFunc})`, { fields, user }]
  return path
}

definition.view({
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
    const publicUserDataPath = limitedFieldsPath(user, userData.publicFields, method)
    console.log("PUBLIC USER DATA PATH", publicUserDataPath)
    return publicUserDataPath
  }
})

if(userData.requiredFields) {
  let requiredUserData = {
    type: Object,
    properties: {}
  }
  for (let fieldName of userData.requiredFields)
    requiredUserData.properties[fieldName] = userData.field.properties[fieldName]
  definition.view({
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
  definition.view({
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
      if(params.limit <= 0) return []
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
  definition.view({
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
      if(params.limit <= 0) return []
      const search = await app.connectToSearch()

      const query = await (userDataDefinition.adminSearchQuery || userDataDefinition.publicSearchQuery)(params)

      console.log('USER QUERY\n' + JSON.stringify(query, null, '  '))
      const result = await search.search(query)
      //console.log('USER SEARCH RESULTS', result.body)
      return result.body.hits.hits.map(hit => hit._source)
    }
  })
}

definition.event({
  name: "userOnline",
  async execute({ user }) {
    console.log("UPDATE USER ONLINE", user)
    await User.update(user, { online: true, lastOnline: new Date() })
  }
})

definition.event({
  name: "userOffline",
  async execute({ user }) {
    console.log("UPDATE USER ONLINE", user)
    await User.update(user, { online: false, lastOnline: new Date() })
  }
})

definition.event({
  name: "allUsersOffline",
  async execute({ user, method }) {
    await app.dao.request(['database', 'query', app.databaseName, `(${
        async (input, output, { table, index }) => {
          await (await input.index(index)).range({
          }).onChange(async (ind, oldInd) => {
            output.table(table).update(ind.to, [
                { op: 'set', property: 'online', value: false },
                { op: 'set', property: 'lastOnline', value: new Date() }
              ])
          })
        }
    })`, { table: User.tableName, index: User.tableName+"_online" }])
  }
})

if(userData.online) {
  definition.trigger({
    name: "userOnline",
    properties: {
    },
    async execute({ user }, context, emit) {
      emit({
        type: "userOnline",
        user
      })
    }
  })

  definition.trigger({
    name: "userOffline",
    properties: {
    },
    async execute({ user }, context, emit) {
      emit({
        type: "userOffline",
        user
      })
    }
  })

  definition.trigger({
    name: "allOffline",
    properties: {
    },
    async execute({ }, context, emit) {
      emit({
        type: "allUsersOffline"
      })
    }
  })
}

module.exports = definition

async function start() {
  app.processServiceDefinition(definition, [ ...app.defaultProcessors ])
  //console.log(JSON.stringify(users.toJSON(), null, "  "))

  await app.updateService(definition)//, { force: true })
  const service = await app.startService(definition,
      { runCommands: true, handleEvents: true, indexSearch: true })

  /*require("../config/metricsWriter.js")(users.name, () => ({
  }))*/
}

if (require.main === module) start().catch( error => { console.error(error); process.exit(1) })
