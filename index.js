const App = require("@live-change/framework")
const validators = require("../validation")
const app = new App()

const users = app.createServiceDefinition({
  name: "users",
  validators
})

const userData = require('../config/userData.js')(users)

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
  userData
}

const User = users.model({
  name: "User",
  properties: {
    ...userFields,
    slug: {
      type: String
    }
  },
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
  },
  async onChange(id, oldValue, newValue) {
    //console.log("USER CHANGE", id, oldValue, newValue)
    if(newValue) {
      const display = await userData.getDisplay(newValue)
      //console.log("DISPLAY CHANGE", newValue.display, display)
      if(display == newValue.display) {
        //console.log("NO DISPLAY CHANGE NEEDED")
        return true
      }
      return User.update(id, { display })
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
    const user = service.cms.generateUid()
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
      data: data
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
    if(!userRow) throw new Error("notFound")
    emit({
      type: "UserUpdated",
      user,
      data: {
        roles,
        userData
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


let userDataFormProperties = {}
for(let fieldName of userData.formUpdate) userDataFormProperties[fieldName] = userData.properties[fieldName]
users.action({
  name: "updateUserData",
  properties: userDataFormProperties,
  returns: {
    type: User,
    idOnly: true
  },
  access: (params, { client }) => !!client.user,
  async execute(params, { client }, emit) {
    const userRow = await User.get(client.user)
    if(!userRow) throw new Error("notFound")
    let cleanData = {}
    for(let fieldName of userData.formUpdate) cleanData[fieldName] = params[fieldName]
    emit({
      type: "UserUpdated",
      user: client.user,
      data: {
        userData: cleanData
      }
    })
    return client.user
  }
})

let completeUserDataFormProperties = {}
for(let fieldName of userData.formComplete) completeUserDataFormProperties[fieldName] = userData.properties[fieldName]
users.action({
  name: "completeUserData",
  properties: completeUserDataFormProperties,
  returns: {
    type: User,
    idOnly: true
  },
  access: (params, { client }) => true, //!!client.user,
  async execute(params, { client }, emit) {
    const userRow = await User.get(client.user)
    if(!userRow) throw new Error("notFound")
    let cleanData = {}
    for(let fieldName of userData.formComplete) cleanData[fieldName] = params[fieldName]
    emit({
      type: "UserUpdated",
      user: client.user,
      data: {
        userData: cleanData
      }
    })
    return client.user
  }
})

for(let fieldName of userData.singleFieldUpdates) {
  const props = {}
  props[fieldName] = userData.properties[fieldName]
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
      if(!userRow) throw new Error("notFound")
      let updateData = {}
      updateData[fieldName] = params[fieldName]
      emit({
        type: "UserUpdated",
        user: client.user,
        data: {
          userData: updateData
        }
      })
      return client.user
    }
  })
}



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
for(let fieldName of userData.publicFields) publicUserData.properties[fieldName] = userData.properties[fieldName]
async function limitedFieldsPath(user, fields, method) {
  const queryFunc = async function(input, output, { fields }) {
    const mapper = function (obj) {
      let out = { id: obj.id, display: obj.display, slug: obj.slug || null }
      for(const field of fields) out[field] = obj.userData[field]
      return out
    }
    await input.table('users_User').onChange((obj, oldObj) =>
        output.change(obj && mapper(obj), oldObj && mapper(oldObj)) )
  }
  const path = ['database', 'queryObject', app.databaseName, `(${queryFunc})`, { fields }]
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
  rawRead: true,
  daoPath({ user }, cd, method) {
    return limitedFieldsPath(user, userData.publicFields, method)
  }
})

if(userData.requiredFields) {
  let requiredUserData = {
    type: Object,
    properties: {}
  }
  for (let fieldName of userData.requiredFields) requiredUserData.properties[fieldName] = userData.properties[fieldName]
  users.view({
    name: "me",
    properties: {},
    returns: {
      ...requiredUserData
    },
    rawRead: true,
    daoPath(ignore, {client, context}, method) {
      if(!client.user) return null
      return limitedFieldsPath(client.user, userData.requiredFields, method)
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
