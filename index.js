const r = require.main.rethinkdb || require('rethinkdb')
if (require.main === module) require.main.rethinkdb = r

const rtcms = require("realtime-cms")

const users = rtcms.createServiceDefinition({
  name: "users",
  eventSourcing: true
})

const userData = require('../config/userData.js')(users)

const User = users.model({
  name: "User",
  properties: {
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
for(let fieldName of userData.publicFields) publicUserData.properties = userData.properties

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
  async read({ user }, cd, method) {
    if(method == "get") {
      let dataMapper = doc => {
        let dataMap = { id: doc('id'), display: doc('display') }
        for(let fieldName of userData.publicFields) {
          dataMap[fieldName] = doc('userData')(fieldName).default(null)
        }
        return dataMap
      }
      return User.table.get(user).do(dataMapper)
    } else {
      let dataMapper = doc => {
        let newValMap = {  display: doc('new_val')('display') }, oldValMap = { display: doc('old_val')('display') }
        for(let fieldName of userData.publicFields) {
          //console.log("FIELD", fieldName)
          newValMap[fieldName] = doc('new_val')('userData')(fieldName).default(null)
          oldValMap[fieldName] = doc('old_val')('userData')(fieldName).default(null)
        }
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
})

module.exports = users

async function start() {
  rtcms.processServiceDefinition(users, [ ...rtcms.defaultProcessors ])
  //console.log(JSON.stringify(users.toJSON(), null, "  "))
  await rtcms.updateService(users)//, { force: true })
  const service = await rtcms.startService(users, { runCommands: true, handleEvents: true })
}

if (require.main === module) start().catch( error => { console.error(error); process.exit(1) })
