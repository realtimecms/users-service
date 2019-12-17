const r = require.main.rethinkdb || require('rethinkdb')
if (require.main === module) require.main.rethinkdb = r

const rtcms = require("realtime-cms")
const validators = require("../validation")

const users = rtcms.createServiceDefinition({
  name: "users",
  eventSourcing: true,
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
    emit([{
      type: "UserUpdated",
      user,
      data: {
        roles,
        userData
      }
    }])
    emit("session", [{
      type: "rolesUpdated",
      user,
      roles,
      oldRoles : userRow.roles || []
    }])
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
    emit([{
      type: "UserUpdated",
      user: client.user,
      data: {
        userData: cleanData
      }
    }])
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
    emit([{
      type: "UserUpdated",
      user: client.user,
      data: {
        userData: cleanData
      }
    }])
    return client.user
  }
})

for(let fieldName of userData.singleFieldUpdates) {
  const props = {}
  props[fieldName] = userData.properties[fieldName]
  users.action({
    name: "updateUser"+fieldName.slice(0,1).toUpperCase()+fieldName.slice(1),
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
      emit([{
        type: "UserUpdated",
        user: client.user,
        data: {
          userData: updateData
        }
      }])
      return client.user
    }
  })
}



users.event({
  name: "loginMethodAdded",
  async execute({ user, method }) {
    console.log("LOGIN METHOD ADDED!", method)
    await User.update(user, userRow => ({
      loginMethods: userRow('loginMethods').append(method)
    }))
  }
})

users.event({
  name: "loginMethodRemoved",
  async execute({ user, method }) {
    console.log("LOGIN METHOD REMOVED!", method)
    await User.update(user, userRow => ({
      loginMethods: userRow('loginMethods').filter(
          m => m('id').ne(method.id).or(m('type').ne(method.type))
      )
    }))
  }
})

let publicUserData = {
  type: Object,
  properties: {}
}
for(let fieldName of userData.publicFields) publicUserData.properties[fieldName] = userData.properties[fieldName]
async function readLimitedFields(user, fields, method) {
  if(method == "get") {
    let dataMapper = doc => {
      let dataMap = { id: doc('id'), display: doc('display') }
      for(let fieldName of fields) {
        dataMap[fieldName] = doc('userData')(fieldName).default(null)
      }
      dataMap.slug = doc('slug').default(null)
      return dataMap
    }
    return User.table.get(user).do(dataMapper)
  } else {
    let dataMapper = doc => {
      let newValMap = {  display: doc('new_val')('display') }, oldValMap = { display: doc('old_val')('display') }
      for(let fieldName of fields) {
        //console.log("FIELD", fieldName)
        newValMap[fieldName] = doc('new_val')('userData')(fieldName).default(null)
        oldValMap[fieldName] = doc('old_val')('userData')(fieldName).default(null)
      }
      newValMap.slug = doc('new_val')('slug').default(null)
      oldValMap.slug = doc('old_val')('slug').default(null)
      return {
        id: doc('id').default(null),
        new_val: r.branch(doc('new_val').default(false), newValMap, null),
        old_val: r.branch(doc('old_val').default(false), oldValMap, null)
      }
    }
    const req = User.table.get(user).changes({includeInitial: true}).map(dataMapper)
    //console.log("REQ", req)
    return req
  }
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
  read({ user }, cd, method) {
    return readLimitedFields(user, userData.publicFields, method)
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
    read(ignore, {client, context}, method) {
      if(!client.user) return r.expr(null)
      return readLimitedFields(client.user, userData.requiredFields, method)
    }
  })
}

module.exports = users

async function start() {
  rtcms.processServiceDefinition(users, [ ...rtcms.defaultProcessors ])
  //console.log(JSON.stringify(users.toJSON(), null, "  "))
  await rtcms.updateService(users)//, { force: true })
  const service = await rtcms.startService(users, { runCommands: true, handleEvents: true })

  require("../config/metricsWriter.js")(users.name, () => ({

  }))
}

if (require.main === module) start().catch( error => { console.error(error); process.exit(1) })
