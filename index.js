const r = require.main.rethinkdb || require('rethinkdb')
if (require.main === module) require.main.rethinkdb = r

const rtcms = require("realtime-cms")
const userData = require('../config/userData.js')

const users = rtcms.createServiceDefinition({
  name: "users",
  eventSourcing: true
})

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
  crud: {
    deleteTrigger: true,
    options: {
      access: (params, {client, service}) => {
        console.log("CHECK ACCESS", client)
        return client.roles.includes('admin')
      }
    }
  },
  onChange(id, oldValue, newValue) {
    //console.log("USER CHANGE", id, oldValue, newValue)
    if((oldValue && newValue && JSON.stringify(oldValue.loginMethods) != JSON.stringify(newValue.loginMethods))
       || (!oldValue && newValue)) {
      let display = "unknown"
      for(let loginMethod of newValue.loginMethods) {
        if(loginMethod.type == 'emailPassword') display = loginMethod.email
      }
      //console.log("DISPLAY CHANGE", newValue.display, display)
      if(display == newValue.display) {
        //console.log("NO DISPLAY CHANGE NEEDED")
        return Promise.resolve(true)
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
    }
  },
  returns: {
    type: User,
    idOnly: true
  },
  async execute({ user, roles }, context, emit) {
    const userRow = await User.get(user)
    if(!userRow) throw new Error("notFound")
    emit([{
      type: "UserUpdated",
      user,
      data: {
        roles
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

module.exports = users

async function start() {
  rtcms.processServiceDefinition(users, [ ...rtcms.defaultProcessors ])
  //console.log(JSON.stringify(users.toJSON(), null, "  "))
  await rtcms.updateService(users)//, { force: true })
  const service = await rtcms.startService(users, { runCommands: true, handleEvents: true })
}

if (require.main === module) start().catch( error => { console.error(error); process.exit(1) })
